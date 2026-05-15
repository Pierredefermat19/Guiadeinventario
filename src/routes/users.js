const express = require('express');
const bcrypt = require('bcryptjs');
const { param, body, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const prisma = require('../lib/prisma');

const router = express.Router();

// POST /api/users
// Solo org_admin puede crear usuarios. Crea warehouse_manager o staff
// y los vincula automáticamente a la organización del admin.
router.post(
  '/users',
  authenticate,
  requireRole('org_admin'),
  [
    body('email').isEmail().normalizeEmail(),
    body('fullName').isString().trim().isLength({ min: 2, max: 255 }),
    body('role').isIn(['warehouse_manager', 'staff']),
    body('pin')
      .if(body('role').equals('staff'))
      .isLength({ min: 4, max: 4 })
      .isNumeric()
      .withMessage('El staff requiere un PIN de 4 dígitos'),
    body('password')
      .if(body('role').equals('warehouse_manager'))
      .isLength({ min: 12 })
      .withMessage('El warehouse_manager requiere contraseña de al menos 12 caracteres'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });
    }

    const { email, fullName, role, pin, password } = req.body;
    const orgId = req.user.orgId;

    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
      }

      // Para warehouse_manager: usa la contraseña provista
      // Para staff: contraseña inutilizable (nunca hacen login con email)
      const passwordHash = role === 'warehouse_manager'
        ? await bcrypt.hash(password, 12)
        : await bcrypt.hash(`staff-nologin-${Date.now()}`, 12);

      const pinHash = role === 'staff'
        ? await bcrypt.hash(pin, 12)
        : null;

      const user = await prisma.user.create({
        data: {
          email,
          fullName,
          passwordHash,
          pinHash,
          organizations: {
            create: { orgId, role },
          },
        },
        select: {
          id: true,
          email: true,
          fullName: true,
          createdAt: true,
          organizations: { select: { role: true, orgId: true } },
        },
      });

      res.status(201).json({
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role,
        orgId,
        createdAt: user.createdAt,
        ...(role === 'staff' && {
          note: 'PIN configurado. Entrégalo directamente al auxiliar.',
        }),
        ...(role === 'warehouse_manager' && {
          note: 'El encargado debe cambiar su contraseña al primer inicio de sesión.',
        }),
      });
    } catch (err) {
      console.error('User create error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// GET /api/users
// Lista todos los usuarios de la organización con sus roles.
router.get(
  '/users',
  authenticate,
  requireRole('org_admin'),
  async (req, res) => {
    try {
      const members = await prisma.userOrganization.findMany({
        where: { orgId: req.user.orgId },
        include: {
          user: { select: { id: true, email: true, fullName: true, isActive: true, pinLockedUntil: true, createdAt: true } },
        },
        orderBy: [{ role: 'asc' }, { user: { fullName: 'asc' } }],
      });

      const now = new Date();
      res.json(members.map((m) => ({
        id: m.user.id,
        email: m.user.email,
        fullName: m.user.fullName,
        role: m.role,
        isActive: m.user.isActive,
        pinLocked: !!(m.user.pinLockedUntil && m.user.pinLockedUntil > now),
        createdAt: m.user.createdAt,
      })));
    } catch (err) {
      console.error('User list error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// PUT /api/users/:id/pin
// org_admin resetea el PIN de un auxiliar
router.put(
  '/users/:id/pin',
  authenticate,
  requireRole('org_admin'),
  [
    param('id').isUUID(),
    body('pin').isLength({ min: 4, max: 4 }).isNumeric(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    const { pin } = req.body;

    try {
      const membership = await prisma.userOrganization.findFirst({
        where: { userId: id, orgId: req.user.orgId, role: 'staff' },
      });
      if (!membership) return res.status(404).json({ error: 'Auxiliar no encontrado en tu organización' });

      const pinHash = await bcrypt.hash(pin, 12);
      await prisma.user.update({
        where: { id },
        data: { pinHash, pinFailedAttempts: 0, pinLockedUntil: null },
      });

      res.json({ message: 'PIN actualizado correctamente.' });
    } catch (err) {
      console.error('Reset PIN error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// POST /api/users/:id/reset-password
// org_admin genera contraseña temporal para un warehouse_manager
router.post(
  '/users/:id/reset-password',
  authenticate,
  requireRole('org_admin'),
  [param('id').isUUID(), body('password').isLength({ min: 12 })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'La contraseña debe tener al menos 12 caracteres' });

    const { id } = req.params;
    try {
      const membership = await prisma.userOrganization.findFirst({
        where: { userId: id, orgId: req.user.orgId, role: 'warehouse_manager' },
      });
      if (!membership) return res.status(404).json({ error: 'Encargado no encontrado en tu organización' });

      const passwordHash = await bcrypt.hash(req.body.password, 12);
      await prisma.user.update({ where: { id }, data: { passwordHash } });
      res.json({ message: 'Contraseña actualizada correctamente.' });
    } catch (err) {
      console.error('Reset password error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// GET /api/warehouses/:warehouseId/staff
// Público: la PWA lo llama antes del login para mostrar la lista de nombres.
// Solo devuelve id + fullName — sin datos sensibles.
router.get(
  '/warehouses/:warehouseId/staff',
  [param('warehouseId').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'warehouseId inválido' });

    const { warehouseId } = req.params;

    try {
      const warehouse = await prisma.warehouse.findUnique({
        where: { id: warehouseId },
        select: { orgId: true },
      });
      if (!warehouse) return res.status(404).json({ error: 'Bodega no encontrada' });

      const staff = await prisma.user.findMany({
        where: {
          organizations: { some: { orgId: warehouse.orgId, role: 'staff' } },
          isActive: true,
        },
        select: { id: true, fullName: true },
        orderBy: { fullName: 'asc' },
      });

      res.json(staff);
    } catch (err) {
      console.error('Staff list error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// PATCH /api/users/:id/status
// org_admin activa o desactiva un usuario de su organización
router.patch(
  '/users/:id/status',
  authenticate,
  requireRole('org_admin'),
  [param('id').isUUID(), body('isActive').isBoolean()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    const { isActive } = req.body;

    try {
      const membership = await prisma.userOrganization.findFirst({
        where: { userId: id, orgId: req.user.orgId },
      });
      if (!membership) return res.status(404).json({ error: 'Usuario no encontrado en tu organización' });
      if (id === req.user.userId) return res.status(400).json({ error: 'No puedes desactivarte a ti mismo' });

      await prisma.user.update({ where: { id }, data: { isActive } });
      res.json({ id, isActive });
    } catch (err) {
      console.error('User status error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
