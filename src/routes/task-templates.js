const express = require('express');
const { body, param, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/task-templates
router.get(
  '/task-templates',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  async (req, res) => {
    try {
      const templates = await prisma.taskTemplate.findMany({
        where: { warehouse: { orgId: req.user.orgId } },
        include: {
          warehouse: { select: { name: true } },
          consumptions: { include: { product: { select: { name: true, unit: true } } } },
          defaultAssignee: { select: { id: true, fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json(templates);
    } catch (err) {
      console.error('Template list error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// POST /api/task-templates
// Crea un template de tarea recurrente con su expresión cron.
router.post(
  '/task-templates',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    body('warehouseId').isUUID(),
    body('title').isString().trim().isLength({ min: 2, max: 255 }),
    body('description').optional({ nullable: true }).isString().trim(),
    body('cronExpr').isString().trim().custom((val) => {
      const parts = val.trim().split(/\s+/);
      if (parts.length !== 5) throw new Error('La expresión cron debe tener 5 campos');
      if (!parts.every((p) => /^[0-9*/,\-]+$/.test(p))) throw new Error('Expresión cron con caracteres inválidos');
      return true;
    }),
    body('defaultAssigneeId').optional({ nullable: true }).isUUID(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });

    const { warehouseId, title, description, cronExpr, defaultAssigneeId } = req.body;

    try {
      const warehouse = await prisma.warehouse.findFirst({
        where: { id: warehouseId, orgId: req.user.orgId },
      });
      if (!warehouse) return res.status(404).json({ error: 'Bodega no encontrada' });

      if (defaultAssigneeId) {
        const assignee = await prisma.userOrganization.findFirst({
          where: { userId: defaultAssigneeId, orgId: req.user.orgId, role: 'staff' },
        });
        if (!assignee) return res.status(404).json({ error: 'Auxiliar no encontrado en esta organización' });
      }

      const template = await prisma.taskTemplate.create({
        data: { warehouseId, title, description, cronExpr, defaultAssigneeId: defaultAssigneeId ?? null },
      });

      res.status(201).json(template);
    } catch (err) {
      console.error('Template create error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// PATCH /api/task-templates/:id — editar título, descripción, cron, o toggle activo
router.patch(
  '/task-templates/:id',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    param('id').isUUID(),
    body('title').optional({ nullable: true }).isString().trim().isLength({ min: 2, max: 255 }),
    body('description').optional({ nullable: true }).isString().trim(),
    body('cronExpr').optional({ nullable: true }).isString().trim().custom((val) => {
      if (val == null) return true;
      const parts = val.trim().split(/\s+/);
      if (parts.length !== 5) throw new Error('La expresión cron debe tener 5 campos');
      if (!parts.every((p) => /^[0-9*/,\-]+$/.test(p))) throw new Error('Expresión cron con caracteres inválidos');
      return true;
    }),
    body('isActive').optional({ nullable: true }).isBoolean(),
    body('defaultAssigneeId').optional({ nullable: true }).custom((val) => {
      if (val === null) return true;
      if (typeof val !== 'string' || !/^[0-9a-f-]{36}$/.test(val)) throw new Error('UUID inválido');
      return true;
    }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos' });

    const { id } = req.params;
    try {
      const template = await prisma.taskTemplate.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
      });
      if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

      if (req.body.defaultAssigneeId) {
        const assignee = await prisma.userOrganization.findFirst({
          where: { userId: req.body.defaultAssigneeId, orgId: req.user.orgId, role: 'staff' },
        });
        if (!assignee) return res.status(404).json({ error: 'Auxiliar no encontrado en esta organización' });
      }

      const updated = await prisma.taskTemplate.update({
        where: { id },
        data: {
          ...(req.body.title !== undefined && { title: req.body.title }),
          ...(req.body.description !== undefined && { description: req.body.description }),
          ...(req.body.cronExpr !== undefined && { cronExpr: req.body.cronExpr }),
          ...(req.body.isActive !== undefined && { isActive: req.body.isActive }),
          ...('defaultAssigneeId' in req.body && { defaultAssigneeId: req.body.defaultAssigneeId ?? null }),
        },
      });
      res.json(updated);
    } catch (err) {
      console.error('Template update error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// DELETE /api/task-templates/:id
router.delete(
  '/task-templates/:id',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [param('id').isUUID()],
  async (req, res) => {
    const { id } = req.params;
    try {
      const template = await prisma.taskTemplate.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
      });
      if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

      await prisma.taskTemplate.delete({ where: { id } });
      res.json({ message: 'Plantilla eliminada.' });
    } catch (err) {
      console.error('Template delete error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// PUT /api/task-templates/:id/consumptions
// Define (o reemplaza) el consumo teórico de insumos por ejecución del template.
// Usa PUT para que sea idempotente: llamar dos veces da el mismo resultado.
router.put(
  '/task-templates/:id/consumptions',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    param('id').isUUID(),
    body('consumptions').isArray({ min: 1 }),
    body('consumptions.*.productId').isUUID(),
    body('consumptions.*.quantity').isFloat({ gt: 0 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });

    const { id: templateId } = req.params;
    const { consumptions } = req.body;

    try {
      const template = await prisma.taskTemplate.findFirst({
        where: { id: templateId, warehouse: { orgId: req.user.orgId } },
      });
      if (!template) return res.status(404).json({ error: 'Template no encontrado' });

      // Verifica que todos los productos existan en la misma org
      const productIds = consumptions.map((c) => c.productId);
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, orgId: req.user.orgId },
        select: { id: true, name: true, unit: true },
      });

      if (products.length !== productIds.length) {
        return res.status(404).json({ error: 'Uno o más productos no encontrados' });
      }

      // Reemplaza todos los consumos del template en una transacción
      const [, created] = await prisma.$transaction([
        prisma.taskTemplateConsumption.deleteMany({ where: { templateId } }),
        prisma.taskTemplateConsumption.createMany({
          data: consumptions.map((c) => ({
            templateId,
            productId: c.productId,
            quantity: c.quantity,
          })),
        }),
      ]);

      const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

      res.json({
        templateId,
        title: template.title,
        consumptions: consumptions.map((c) => ({
          productId: c.productId,
          productName: productMap[c.productId]?.name,
          unit: productMap[c.productId]?.unit,
          quantityPerExecution: c.quantity,
        })),
      });
    } catch (err) {
      console.error('Consumption upsert error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// GET /api/task-templates/:id/consumptions
router.get(
  '/task-templates/:id/consumptions',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [param('id').isUUID()],
  async (req, res) => {
    const { id: templateId } = req.params;

    try {
      const template = await prisma.taskTemplate.findFirst({
        where: { id: templateId, warehouse: { orgId: req.user.orgId } },
        include: {
          consumptions: {
            include: { product: { select: { name: true, unit: true } } },
          },
        },
      });

      if (!template) return res.status(404).json({ error: 'Template no encontrado' });

      res.json({
        templateId: template.id,
        title: template.title,
        cronExpr: template.cronExpr,
        consumptions: template.consumptions.map((c) => ({
          productId: c.productId,
          productName: c.product.name,
          unit: c.product.unit,
          quantityPerExecution: Number(c.quantity),
        })),
      });
    } catch (err) {
      console.error('Consumption list error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// POST /api/task-templates/:id/trigger
// Genera una tarea ahora mismo desde esta plantilla, sin esperar al cron.
// Útil para probar la plantilla o reponer una tarea que el cron no generó.
// No usa ventana de idempotencia — siempre crea una nueva tarea.
router.post(
  '/task-templates/:id/trigger',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [param('id').isUUID()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'ID inválido' });

    const { id } = req.params;
    try {
      const template = await prisma.taskTemplate.findFirst({
        where: { id, warehouse: { orgId: req.user.orgId } },
      });
      if (!template) return res.status(404).json({ error: 'Plantilla no encontrada' });

      const task = await prisma.task.create({
        data: {
          warehouseId: template.warehouseId,
          templateId: template.id,
          title: template.title,
          description: template.description,
          status: 'disponible',
          scheduledFor: new Date(),
          ...(template.defaultAssigneeId && { assignedTo: template.defaultAssigneeId }),
        },
        select: { id: true, title: true, status: true, scheduledFor: true },
      });

      res.status(201).json({ message: 'Tarea generada correctamente.', task });
    } catch (err) {
      console.error('Template trigger error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
