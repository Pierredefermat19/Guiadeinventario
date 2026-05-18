const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/warehouses/:id/info — público, solo devuelve el nombre (usado por la PWA antes del login)
router.get('/warehouses/:id/info', [param('id').isUUID()], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });
  try {
    const warehouse = await prisma.warehouse.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true },
    });
    if (!warehouse) return res.status(404).json({ error: 'Bodega no encontrada' });
    res.json(warehouse);
  } catch (err) {
    console.error('Warehouse info error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/warehouses
router.get('/warehouses', authenticate, requireRole('org_admin', 'warehouse_manager'), async (req, res) => {
  try {
    const warehouses = await prisma.warehouse.findMany({
      where: { orgId: req.user.orgId },
      orderBy: { name: 'asc' },
    });
    res.json(warehouses);
  } catch (err) {
    console.error('Warehouses list error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/warehouses
router.post(
  '/warehouses',
  authenticate,
  requireRole('org_admin'),
  [
    body('name').isString().trim().isLength({ min: 1, max: 255 }),
    body('location').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });

    const { name, location } = req.body;
    try {
      const warehouse = await prisma.warehouse.create({
        data: { orgId: req.user.orgId, name, location: location || null },
      });
      res.status(201).json(warehouse);
    } catch (err) {
      console.error('Warehouse create error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// PATCH /api/warehouses/:id
router.patch(
  '/warehouses/:id',
  authenticate,
  requireRole('org_admin'),
  [
    param('id').isUUID(),
    body('name').optional().isString().trim().isLength({ min: 1, max: 255 }),
    body('location').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    try {
      const warehouse = await prisma.warehouse.findFirst({ where: { id, orgId: req.user.orgId } });
      if (!warehouse) return res.status(404).json({ error: 'Bodega no encontrada' });

      const updated = await prisma.warehouse.update({
        where: { id },
        data: {
          ...(req.body.name     !== undefined && { name: req.body.name }),
          ...(req.body.location !== undefined && { location: req.body.location || null }),
        },
      });
      res.json(updated);
    } catch (err) {
      console.error('Warehouse update error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// GET /api/warehouses/:id/shifts  — turnos activos y completados hoy
router.get(
  '/warehouses/:id/shifts',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [param('id').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    const { id: warehouseId } = req.params;
    try {
      const wh = await prisma.warehouse.findFirst({ where: { id: warehouseId, orgId: req.user.orgId } });
      if (!wh) return res.status(404).json({ error: 'Bodega no encontrada' });

      const now = new Date();
      const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);

      const sessions = await prisma.shiftSession.findMany({
        where: {
          warehouseId,
          OR: [
            { endedAt: null },
            { startedAt: { gte: startOfDay } },
          ],
        },
        include: { user: { select: { fullName: true } } },
        orderBy: { startedAt: 'desc' },
      });

      res.json(sessions.map((s) => {
        const durationMin = s.endedAt
          ? Math.round((new Date(s.endedAt) - new Date(s.startedAt)) / 60000)
          : Math.round((now - new Date(s.startedAt)) / 60000);
        return {
          id: s.id,
          userId: s.userId,
          fullName: s.user?.fullName ?? 'Desconocido',
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          active: !s.endedAt,
          durationMinutes: durationMin,
        };
      }));
    } catch (err) {
      console.error('Shifts error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
