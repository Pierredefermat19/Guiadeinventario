const express = require('express');
const { validationResult, param, body } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { generateUploadUrl } = require('../lib/supabase');
const prisma = require('../lib/prisma');

const router = express.Router();

const PHOTO_DEADLINE_HOURS = 2;

// ─────────────────────────────────────────────
// POST /api/tasks  — crear tarea manual
// ─────────────────────────────────────────────
router.post(
  '/tasks',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    body('warehouseId').isUUID(),
    body('title').isString().trim().isLength({ min: 2, max: 255 }),
    body('description').optional().isString().trim(),
    body('assignedTo').optional().isUUID(),
    body('afterPhotoRequired').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });

    const { warehouseId, title, description, assignedTo, afterPhotoRequired = true } = req.body;
    try {
      const warehouse = await prisma.warehouse.findFirst({
        where: { id: warehouseId, orgId: req.user.orgId },
      });
      if (!warehouse) return res.status(404).json({ error: 'Bodega no encontrada' });

      const task = await prisma.task.create({
        data: {
          warehouseId,
          title,
          description: description || null,
          assignedTo: assignedTo || null,
          afterPhotoRequired,
          status: 'disponible',
          scheduledFor: new Date(),
        },
      });
      res.status(201).json(task);
    } catch (err) {
      console.error('Task create error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// ─────────────────────────────────────────────
// GET /api/tasks/today
// ─────────────────────────────────────────────
router.get('/tasks/today', authenticate, async (req, res) => {
  try {
    const warehouseId = req.user.warehouseId ?? req.query.warehouseId;
    if (!warehouseId) {
      return res.status(400).json({ error: 'warehouseId requerido' });
    }

    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay   = new Date(now); endOfDay.setHours(23, 59, 59, 999);

    const tasks = await prisma.task.findMany({
      where: {
        warehouseId,
        OR: [
          { scheduledFor: { gte: startOfDay, lte: endOfDay } },
          { scheduledFor: null, createdAt: { gte: startOfDay, lte: endOfDay } },
        ],
        status: { not: 'completada' },
      },
      select: {
        id: true, title: true, description: true, status: true,
        scheduledFor: true, startedAt: true, assignedTo: true,
        afterPhotoRequired: true, photoDeadline: true,
        photos: { select: { type: true } },
        user: { select: { fullName: true } },
        template: { select: { title: true } },
      },
      orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
    });

    const enriched = tasks.map((t) => {
      const hasBeforePhoto = t.photos.some((p) => p.type === 'antes');
      const hasAfterPhoto  = t.photos.some((p) => p.type === 'despues');
      const isExpired = t.photoDeadline && t.photoDeadline < now;

      return {
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        scheduledFor: t.scheduledFor,
        assignedTo: t.user?.fullName ?? null,
        isAssignedToMe: t.assignedTo === req.user.userId,
        isAvailable: t.status === 'disponible' && !t.assignedTo,
        afterPhotoRequired: t.afterPhotoRequired,
        photoDeadline: t.photoDeadline,
        photoDeadlineExpired: isExpired ?? false,
        photos: { hasBeforePhoto, hasAfterPhoto },
        isRecurring: !!t.template,
      };
    });

    res.json({ date: now.toISOString().split('T')[0], warehouseId, total: enriched.length, tasks: enriched });
  } catch (err) {
    console.error('Tasks today error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ─────────────────────────────────────────────
// PATCH /api/tasks/:id/start
// El auxiliar toma la tarea y pasa a en_progreso.
// ─────────────────────────────────────────────
router.patch(
  '/tasks/:id/start',
  authenticate,
  [param('id').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    const { id } = req.params;
    const userId = req.user.userId;

    try {
      const task = await prisma.task.findUnique({ where: { id } });

      if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
      if (task.status !== 'disponible') {
        return res.status(409).json({
          error: `No se puede iniciar: la tarea está en estado '${task.status}'`,
        });
      }
      if (task.assignedTo && task.assignedTo !== userId) {
        return res.status(403).json({ error: 'Esta tarea ya fue tomada por otro auxiliar' });
      }

      const updated = await prisma.task.update({
        where: { id },
        data: { status: 'en_progreso', assignedTo: userId, startedAt: new Date() },
      });

      // Genera URL para subir foto del "antes" de inmediato (upload desacoplado)
      let beforeUploadUrl = null;
      try {
        const upload = await generateUploadUrl(id, 'antes');
        beforeUploadUrl = upload.signedUrl;

        await prisma.taskPhoto.create({
          data: { taskId: id, url: `pending:${upload.path}`, type: 'antes' },
        });
      } catch {
        // No bloquear el inicio si Supabase Storage falla
      }

      res.json({
        taskId: id,
        status: updated.status,
        startedAt: updated.startedAt,
        beforePhotoUploadUrl: beforeUploadUrl,
        message: beforeUploadUrl
          ? 'Sube la foto del ANTES ahora mientras tengas señal.'
          : 'Sin conexión. La foto del antes se subirá cuando tengas señal.',
      });
    } catch (err) {
      console.error('Task start error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// ─────────────────────────────────────────────
// PATCH /api/tasks/:id/complete
// Completa la tarea. Si no hay foto del después,
// pasa a 'completada_pendiente_foto' con deadline de 2h.
// ─────────────────────────────────────────────
router.patch(
  '/tasks/:id/complete',
  authenticate,
  [
    param('id').isUUID(),
    body('offlineCompletedAt').optional().isISO8601(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    const userId = req.user.userId;
    // La PWA puede enviar el timestamp real de cuando se completó offline
    const completedAt = req.body.offlineCompletedAt
      ? new Date(req.body.offlineCompletedAt)
      : new Date();

    try {
      const task = await prisma.task.findUnique({
        where: { id },
        include: { photos: { select: { type: true, url: true } } },
      });

      if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
      if (task.assignedTo !== userId) {
        return res.status(403).json({ error: 'Solo quien inició la tarea puede completarla' });
      }
      if (!['en_progreso'].includes(task.status)) {
        return res.status(409).json({
          error: `No se puede completar: estado actual '${task.status}'`,
        });
      }

      const hasRealAfterPhoto = task.photos.some(
        (p) => p.type === 'despues' && !p.url.startsWith('pending:'),
      );

      let newStatus;
      let photoDeadline = null;
      let afterUploadUrl = null;

      if (!task.afterPhotoRequired || hasRealAfterPhoto) {
        newStatus = 'completada';
      } else {
        // Foto pendiente — genera URL para subir después y registra placeholder
        newStatus = 'completada_pendiente_foto';
        photoDeadline = new Date(completedAt.getTime() + PHOTO_DEADLINE_HOURS * 60 * 60 * 1000);

        try {
          const upload = await generateUploadUrl(id, 'despues');
          afterUploadUrl = upload.signedUrl;

          await prisma.taskPhoto.create({
            data: { taskId: id, url: `pending:${upload.path}`, type: 'despues' },
          });
        } catch {
          // No bloquear la finalización si Supabase falla
        }
      }

      const updated = await prisma.task.update({
        where: { id },
        data: { status: newStatus, completedAt, photoDeadline },
      });

      const duration = task.startedAt
        ? Math.round((completedAt - task.startedAt) / 60000)
        : null;

      res.json({
        taskId: id,
        status: newStatus,
        completedAt: updated.completedAt,
        durationMinutes: duration,
        ...(newStatus === 'completada_pendiente_foto' && {
          photoDeadline,
          afterPhotoUploadUrl: afterUploadUrl,
          warning: '⚠️ Tarea guardada. Tienes 2 horas para subir la foto del DESPUÉS.',
        }),
      });
    } catch (err) {
      console.error('Task complete error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// ─────────────────────────────────────────────
// POST /api/tasks/:id/photos/upload-url
// Genera una presigned URL para subir una foto
// (útil para reintentar subidas fallidas offline).
// ─────────────────────────────────────────────
router.post(
  '/tasks/:id/photos/upload-url',
  authenticate,
  [param('id').isUUID(), body('type').isIn(['antes', 'despues'])],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'type debe ser antes o despues' });

    const { id } = req.params;
    const { type } = req.body;

    try {
      const task = await prisma.task.findUnique({ where: { id } });
      if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
      if (task.assignedTo !== req.user.userId) {
        return res.status(403).json({ error: 'Sin acceso a esta tarea' });
      }

      const { signedUrl, path } = await generateUploadUrl(id, type);

      // Actualiza o crea el registro de foto (reemplaza placeholder pending:)
      await prisma.taskPhoto.upsert({
        where: {
          // No hay unique en taskId+type, usamos findFirst + update manual
          id: (await prisma.taskPhoto.findFirst({ where: { taskId: id, type } }))?.id ?? 'new',
        },
        update: { url: `pending:${path}` },
        create: { taskId: id, url: `pending:${path}`, type },
      });

      res.json({ uploadUrl: signedUrl, path, expiresInSeconds: 300 });
    } catch (err) {
      console.error('Upload URL error:', err);
      res.status(500).json({ error: 'Error generando URL de subida' });
    }
  },
);

module.exports = router;
