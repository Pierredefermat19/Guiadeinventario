const express = require('express');
const { validationResult, param, body, query } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const { generateUploadUrl, generateViewUrl } = require('../lib/supabase');
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
    body('description').optional({ nullable: true }).isString().trim(),
    body('assignedTo').optional({ nullable: true }).isUUID(),
    body('afterPhotoRequired').optional({ nullable: true }).isBoolean(),
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

      if (assignedTo) {
        const assignee = await prisma.userOrganization.findFirst({
          where: { userId: assignedTo, orgId: req.user.orgId, role: 'staff' },
        });
        if (!assignee) return res.status(404).json({ error: 'Auxiliar no encontrado en esta organización' });
      }

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

    // Staff: warehouseId comes from trusted JWT. Admins/managers: verify ownership.
    if (req.user.role !== 'staff') {
      const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, orgId: req.user.orgId } });
      if (!wh) return res.status(404).json({ error: 'Bodega no encontrada' });
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
        NOT: { status: { in: ['completada', 'cancelada'] } },
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
        assignedToId: t.assignedTo ?? null,
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
// GET /api/tasks/history  — tareas completadas (admin/manager)
// ─────────────────────────────────────────────
router.get(
  '/tasks/history',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    query('warehouseId').optional().isUUID(),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Parámetros inválidos' });

    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    const { warehouseId, dateFrom, dateTo } = req.query;

    try {
      const tasks = await prisma.task.findMany({
        where: {
          warehouse: { orgId: req.user.orgId },
          ...(warehouseId && { warehouseId }),
          status: { in: ['completada', 'completada_pendiente_foto', 'completada_sin_foto'] },
          ...(dateFrom && { completedAt: { gte: new Date(dateFrom) } }),
          ...(dateTo   && { completedAt: { lte: new Date(dateTo) } }),
        },
        select: {
          id: true, title: true, status: true,
          scheduledFor: true, startedAt: true, completedAt: true,
          afterPhotoRequired: true,
          user:     { select: { fullName: true } },
          template: { select: { title: true } },
          photos:   { select: { type: true, url: true } },
        },
        orderBy: { completedAt: 'desc' },
        take: limit,
      });

      res.json(tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        scheduledFor: t.scheduledFor,
        completedAt: t.completedAt,
        durationMinutes: t.startedAt && t.completedAt
          ? Math.round((new Date(t.completedAt) - new Date(t.startedAt)) / 60000)
          : null,
        assignedTo: t.user?.fullName ?? null,
        isRecurring: !!t.template,
        photos: {
          hasBeforePhoto: t.photos.some((p) => p.type === 'antes'   && !p.url.startsWith('pending:')),
          hasAfterPhoto:  t.photos.some((p) => p.type === 'despues' && !p.url.startsWith('pending:')),
          hasPendingPhoto: t.photos.some((p) => p.url.startsWith('pending:')),
        },
      })));
    } catch (err) {
      console.error('Task history error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// ─────────────────────────────────────────────
// GET /api/tasks/:id/photos  — URLs firmadas para visualizar evidencia
// ─────────────────────────────────────────────
router.get(
  '/tasks/:id/photos',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [param('id').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    const { id } = req.params;
    try {
      const task = await prisma.task.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
        select: { id: true, title: true, photos: { select: { type: true, url: true } } },
      });
      if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });

      const photos = await Promise.all(
        task.photos
          .filter((p) => !p.url.startsWith('pending:'))
          .map(async (p) => {
            try {
              const signedUrl = await generateViewUrl(p.url, 3600);
              return { type: p.type, url: signedUrl };
            } catch {
              return { type: p.type, url: null };
            }
          }),
      );

      res.json({ taskId: id, title: task.title, photos });
    } catch (err) {
      console.error('Task photos error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

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
      const task = await prisma.task.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
      });

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
    body('offlineCompletedAt').optional({ nullable: true }).isISO8601(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    const userId = req.user.userId;
    // La PWA puede enviar el timestamp real de cuando se completó offline
    const now = new Date();
    const rawCompleted = req.body.offlineCompletedAt ? new Date(req.body.offlineCompletedAt) : now;
    // Clamp: no puede ser en el futuro ni más de 24h en el pasado
    const completedAt = rawCompleted > now ? now
      : rawCompleted < new Date(now - 24 * 60 * 60 * 1000) ? now
      : rawCompleted;

    try {
      const task = await prisma.task.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
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

      if (!task.afterPhotoRequired || hasRealAfterPhoto) {
        newStatus = 'completada';
      } else {
        // Foto pendiente — la PWA pedirá la URL de subida por separado con /upload-url
        newStatus = 'completada_pendiente_foto';
        photoDeadline = new Date(completedAt.getTime() + PHOTO_DEADLINE_HOURS * 60 * 60 * 1000);
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
      const task = await prisma.task.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
      });
      if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
      const isAdmin = ['org_admin', 'warehouse_manager'].includes(req.user.role);
      if (!isAdmin && task.assignedTo !== req.user.userId) {
        return res.status(403).json({ error: 'Sin acceso a esta tarea' });
      }

      const { signedUrl, path } = await generateUploadUrl(id, type);

      await prisma.taskPhoto.upsert({
        where: { taskId_type: { taskId: id, type } },
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

// ─────────────────────────────────────────────
// POST /api/tasks/:id/photos/confirm
// La PWA llama esto después de subir exitosamente a Supabase.
// Convierte el registro pending:path → path real en la BD.
// ─────────────────────────────────────────────
router.post(
  '/tasks/:id/photos/confirm',
  authenticate,
  [
    param('id').isUUID(),
    body('path').isString().trim().isLength({ min: 5 }).custom((val) => {
      if (!/^tasks\/[0-9a-f-]{36}\/(antes|despues)-\d+\.[a-z]+$/i.test(val)) {
        throw new Error('Ruta de archivo inválida');
      }
      return true;
    }),
    body('type').isIn(['antes', 'despues']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    const { path, type } = req.body;

    try {
      const photo = await prisma.taskPhoto.findFirst({
        where: { taskId: id, type, url: `pending:${path}` },
      });
      if (!photo) return res.status(404).json({ error: 'Registro de foto no encontrado' });

      await prisma.taskPhoto.update({
        where: { id: photo.id },
        data: { url: path },
      });

      res.json({ ok: true });
    } catch (err) {
      console.error('Photo confirm error:', err);
      res.status(500).json({ error: 'Error confirmando foto' });
    }
  },
);

// ─────────────────────────────────────────────
// PATCH /api/tasks/:id/assign  — admin asigna tarea a un auxiliar (o la desasigna)
// ─────────────────────────────────────────────
router.patch(
  '/tasks/:id/assign',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [param('id').isUUID(), body('assignedTo').optional({ nullable: true }).isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    const { assignedTo } = req.body;
    try {
      const task = await prisma.task.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
      });
      if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
      if (task.status !== 'disponible') {
        return res.status(409).json({ error: `Solo se puede reasignar una tarea en estado 'disponible'` });
      }

      if (assignedTo) {
        const assignee = await prisma.userOrganization.findFirst({
          where: { userId: assignedTo, orgId: req.user.orgId, role: 'staff' },
        });
        if (!assignee) return res.status(404).json({ error: 'Auxiliar no encontrado en esta organización' });
      }

      const updated = await prisma.task.update({
        where: { id },
        data: { assignedTo: assignedTo ?? null },
      });
      res.json({ taskId: id, assignedTo: updated.assignedTo });
    } catch (err) {
      console.error('Task assign error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// ─────────────────────────────────────────────
// PATCH /api/tasks/:id/cancel  — admin cancela una tarea (soft-delete)
// Solo permitido si está en estado 'disponible'.
// ─────────────────────────────────────────────
router.patch(
  '/tasks/:id/cancel',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [param('id').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    const { id } = req.params;
    try {
      const task = await prisma.task.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
      });
      if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
      if (task.status !== 'disponible') {
        return res.status(409).json({ error: `Solo se puede cancelar una tarea en estado 'disponible'` });
      }

      await prisma.task.update({ where: { id }, data: { status: 'cancelada' } });
      res.json({ taskId: id, status: 'cancelada' });
    } catch (err) {
      console.error('Task cancel error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
