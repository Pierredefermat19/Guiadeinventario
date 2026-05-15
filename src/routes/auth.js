const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { rateLimit } = require('express-rate-limit');
const prisma = require('../lib/prisma');

const router = express.Router();

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 30;

// Capa 1: rate limit por IP — máx 10 intentos de PIN en 15 min
const pinRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
});

const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Espera 15 minutos.' },
});

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 1 }),
];

// POST /api/auth/login
router.post('/login', loginRateLimit, loginValidation, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Email o contraseña inválidos' });
  }

  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        organizations: {
          include: { organization: true },
        },
      },
    });

    // Mismo mensaje para usuario inexistente y contraseña incorrecta
    // (evita enumerar usuarios válidos por timing)
    const GENERIC_ERROR = 'Credenciales incorrectas';

    if (!user) {
      await bcrypt.hash('dummy', 12); // mantiene tiempo de respuesta constante
      return res.status(401).json({ error: GENERIC_ERROR });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: GENERIC_ERROR });
    }

    // Toma la primera membresía (un admin puede pertenecer a múltiples orgs en el futuro)
    const membership = user.organizations[0];
    if (!membership) {
      return res.status(403).json({ error: 'Usuario sin organización asignada' });
    }

    const payload = {
      userId: user.id,
      email: user.email,
      orgId: membership.orgId,
      role: membership.role,
    };

    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: membership.role,
        org: {
          id: membership.organization.id,
          name: membership.organization.name,
          slug: membership.organization.slug,
        },
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/change-pin  — staff cambia su propio PIN
router.post('/change-pin', pinRateLimit, [
  body('currentPin').isLength({ min: 4, max: 4 }).isNumeric(),
  body('newPin').isLength({ min: 4, max: 4 }).isNumeric(),
], async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Los PINs deben ser exactamente 4 dígitos numéricos' });
  }

  const { currentPin, newPin } = req.body;

  if (currentPin === newPin) {
    return res.status(400).json({ error: 'El PIN nuevo debe ser diferente al actual' });
  }

  try {
    const { userId } = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user?.pinHash) {
      return res.status(403).json({ error: 'Usuario sin PIN asignado' });
    }

    // Verifica que la cuenta no esté bloqueada
    if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
      const minLeft = Math.ceil((user.pinLockedUntil - new Date()) / 60000);
      return res.status(429).json({
        error: `Cuenta bloqueada. Intenta en ${minLeft} minuto(s).`,
      });
    }

    const valid = await bcrypt.compare(currentPin, user.pinHash);
    if (!valid) {
      return res.status(401).json({ error: 'PIN actual incorrecto' });
    }

    const newPinHash = await bcrypt.hash(newPin, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { pinHash: newPinHash, pinFailedAttempts: 0, pinLockedUntil: null },
    });

    res.json({ message: 'PIN actualizado correctamente.' });
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
});

// POST /api/auth/pin  — login de staff con PIN de 4 dígitos
router.post('/pin', pinRateLimit, [
  body('userId').isUUID(),
  body('pin').isLength({ min: 4, max: 4 }).isNumeric(),
  body('warehouseId').isUUID(),
  body('deviceId').optional().isString().trim(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }

  const { userId, pin, warehouseId, deviceId } = req.body;
  const GENERIC_ERROR = 'PIN incorrecto';

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });

    if (!user || !user.pinHash) {
      await bcrypt.hash('dummy', 12);
      return res.status(401).json({ error: GENERIC_ERROR });
    }

    if (!user.isActive) {
      await bcrypt.hash('dummy', 12);
      return res.status(401).json({ error: GENERIC_ERROR });
    }

    // Capa 2: lockout por usuario en DB
    if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
      const minLeft = Math.ceil((user.pinLockedUntil - new Date()) / 60000);
      return res.status(429).json({
        error: `Cuenta bloqueada. Intenta en ${minLeft} minuto(s).`,
      });
    }

    const valid = await bcrypt.compare(pin, user.pinHash);

    if (!valid) {
      const newAttempts = user.pinFailedAttempts + 1;
      const shouldLock = newAttempts >= PIN_MAX_ATTEMPTS;

      await prisma.user.update({
        where: { id: userId },
        data: {
          pinFailedAttempts: newAttempts,
          pinLockedUntil: shouldLock
            ? new Date(Date.now() + PIN_LOCKOUT_MINUTES * 60 * 1000)
            : null,
        },
      });

      if (shouldLock) {
        return res.status(429).json({
          error: `PIN incorrecto. Cuenta bloqueada por ${PIN_LOCKOUT_MINUTES} minutos.`,
        });
      }

      const remaining = PIN_MAX_ATTEMPTS - newAttempts;
      return res.status(401).json({
        error: `${GENERIC_ERROR}. Te quedan ${remaining} intento(s).`,
      });
    }

    // PIN correcto — resetear contador y cerrar sesión anterior si existe
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { pinFailedAttempts: 0, pinLockedUntil: null },
      }),
      prisma.shiftSession.updateMany({
        where: { userId, warehouseId, endedAt: null },
        data: { endedAt: new Date() },
      }),
    ]);

    const shiftHours = Math.max(1, Math.min(24, parseInt(process.env.SHIFT_SESSION_HOURS || '12', 10)));
    const session = await prisma.shiftSession.create({
      data: { userId, warehouseId, deviceId },
      include: { warehouse: { select: { name: true, orgId: true } } },
    });

    const token = jwt.sign(
      { sessionId: session.id, userId, warehouseId, orgId: session.warehouse.orgId, role: 'staff' },
      process.env.JWT_SECRET,
      { expiresIn: `${shiftHours}h` },
    );

    res.status(201).json({
      token,
      session: {
        id: session.id,
        warehouseId,
        warehouseName: session.warehouse.name,
        startedAt: session.startedAt,
        expiresInHours: shiftHours,
      },
    });
  } catch (err) {
    console.error('PIN login error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/pin/end  — cierre explícito de turno
router.post('/pin/end', async (req, res) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  try {
    const { sessionId, userId, warehouseId } = jwt.verify(
      header.split(' ')[1],
      process.env.JWT_SECRET,
    );

    // Bloquear cierre si hay fotos pendientes — mitiga pérdida por cache borrado
    const pending = await prisma.task.findMany({
      where: { assignedTo: userId, warehouseId, status: 'completada_pendiente_foto' },
      select: { id: true, title: true, photoDeadline: true },
    });

    if (pending.length > 0) {
      return res.status(409).json({
        error: 'No puedes cerrar el turno con evidencias pendientes de subir.',
        pendingTasks: pending.map((t) => ({
          id: t.id,
          title: t.title,
          photoDeadline: t.photoDeadline,
        })),
      });
    }

    const { count } = await prisma.shiftSession.updateMany({
      where: { id: sessionId, endedAt: null },
      data: { endedAt: new Date() },
    });
    if (count === 0) {
      return res.status(409).json({ error: 'El turno ya fue cerrado.' });
    }

    res.json({ message: 'Turno cerrado correctamente.' });
  } catch {
    res.status(401).json({ error: 'Token inválido o turno ya cerrado' });
  }
});

module.exports = router;
