const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const prisma = require('../lib/prisma');

const router = express.Router();

const VALID_TYPES = ['entrada', 'salida', 'transferencia', 'ajuste'];

// POST /api/movements
// Solo el encargado de bodega (warehouse_manager) o el admin pueden registrar movimientos.
// El auxiliar NUNCA toca esta ruta.
router.post(
  '/movements',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    body('productId').isUUID(),
    body('warehouseId').isUUID(),
    body('type').isIn(VALID_TYPES),
    body('quantity').isFloat({ gt: 0 }),
    body('deliveredTo').optional().isUUID(),
    body('notes').optional().isString().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });
    }

    const { productId, warehouseId, type, quantity, deliveredTo, notes } = req.body;
    const qty = parseFloat(quantity);

    // En salidas, el destinatario es obligatorio para trazabilidad
    if (type === 'salida' && !deliveredTo) {
      return res.status(400).json({
        error: 'Las salidas requieren especificar a quién se entrega el insumo (deliveredTo)',
      });
    }

    try {
      const [product, warehouse] = await Promise.all([
        prisma.product.findFirst({ where: { id: productId, orgId: req.user.orgId } }),
        prisma.warehouse.findFirst({ where: { id: warehouseId, orgId: req.user.orgId } }),
      ]);

      if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
      if (!warehouse) return res.status(404).json({ error: 'Bodega no encontrada' });

      if (deliveredTo) {
        const recipient = await prisma.user.findFirst({
          where: {
            id: deliveredTo,
            organizations: { some: { orgId: req.user.orgId, role: 'staff' } },
          },
          select: { id: true, fullName: true },
        });
        if (!recipient) {
          return res.status(404).json({ error: 'Auxiliar destinatario no encontrado en esta organización' });
        }
      }

      if (type === 'salida') {
        const currentStock = await prisma.stock.findUnique({
          where: { warehouseId_productId: { warehouseId, productId } },
        });
        const currentQty = Number(currentStock?.quantity ?? 0);
        if (currentQty < qty) {
          return res.status(409).json({
            error: `Stock insuficiente. Disponible: ${currentQty} ${product.unit}`,
          });
        }
      }

      const delta = type === 'salida' ? -qty : qty;

      const [movement] = await prisma.$transaction([
        prisma.movement.create({
          data: { warehouseId, productId, type, quantity: qty, notes, performedBy: req.user.userId, deliveredTo },
        }),
        prisma.stock.upsert({
          where: { warehouseId_productId: { warehouseId, productId } },
          create: { warehouseId, productId, quantity: delta, lastUpdated: new Date() },
          update: { quantity: { increment: delta }, lastUpdated: new Date() },
        }),
      ]);

      const updatedStock = await prisma.stock.findUnique({
        where: { warehouseId_productId: { warehouseId, productId } },
      });
      const belowThreshold = updatedStock && Number(updatedStock.quantity) <= product.reorderThreshold;

      res.status(201).json({
        movementId: movement.id,
        type,
        product: { id: productId, name: product.name, unit: product.unit },
        quantity: qty,
        deliveredTo: deliveredTo ?? null,
        stockAfter: Number(updatedStock?.quantity ?? 0),
        ...(belowThreshold && {
          alert: `⚠️ Stock de "${product.name}" bajo el mínimo (${product.reorderThreshold} ${product.unit}).`,
        }),
      });
    } catch (err) {
      console.error('Movement error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// POST /api/movements/batch  — Canasta de entrega
// El encargado acumula N productos en la PWA y los despacha en un solo request.
// Todos los ítems van al mismo auxiliar y a la misma bodega.
router.post(
  '/movements/batch',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    body('warehouseId').isUUID(),
    body('deliveredTo').isUUID(),
    body('items').isArray({ min: 1, max: 50 }),
    body('items.*.productId').isUUID(),
    body('items.*.quantity').isFloat({ gt: 0 }),
    body('items.*.notes').optional().isString().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });
    }

    const { warehouseId, deliveredTo, items } = req.body;
    const orgId = req.user.orgId;

    try {
      // Validaciones en paralelo: bodega, destinatario, y todos los productos
      const productIds = [...new Set(items.map((i) => i.productId))];

      const [warehouse, recipient, products] = await Promise.all([
        prisma.warehouse.findFirst({ where: { id: warehouseId, orgId } }),
        prisma.user.findFirst({
          where: { id: deliveredTo, organizations: { some: { orgId, role: 'staff' } } },
          select: { id: true, fullName: true },
        }),
        prisma.product.findMany({
          where: { id: { in: productIds }, orgId },
          include: { stock: { where: { warehouseId }, select: { quantity: true } } },
        }),
      ]);

      if (!warehouse) return res.status(404).json({ error: 'Bodega no encontrada' });
      if (!recipient) return res.status(404).json({ error: 'Auxiliar destinatario no encontrado' });
      if (products.length !== productIds.length) {
        return res.status(404).json({ error: 'Uno o más productos no encontrados en esta organización' });
      }

      // Verifica stock suficiente para TODOS los ítems antes de tocar nada
      const productMap = Object.fromEntries(products.map((p) => [p.id, p]));
      const stockErrors = [];

      for (const item of items) {
        const product = productMap[item.productId];
        const available = Number(product.stock[0]?.quantity ?? 0);
        if (available < item.quantity) {
          stockErrors.push(`"${product.name}": disponible ${available} ${product.unit}, pedido ${item.quantity}`);
        }
      }

      if (stockErrors.length > 0) {
        return res.status(409).json({
          error: 'Stock insuficiente para algunos productos',
          details: stockErrors,
        });
      }

      // Todo válido — ejecuta todos los movimientos en una sola transacción
      const now = new Date();
      const ops = items.flatMap((item) => [
        prisma.movement.create({
          data: {
            warehouseId,
            productId: item.productId,
            type: 'salida',
            quantity: item.quantity,
            notes: item.notes ?? null,
            performedBy: req.user.userId,
            deliveredTo,
          },
        }),
        prisma.stock.upsert({
          where: { warehouseId_productId: { warehouseId, productId: item.productId } },
          create: { warehouseId, productId: item.productId, quantity: -item.quantity, lastUpdated: now },
          update: { quantity: { increment: -item.quantity }, lastUpdated: now },
        }),
      ]);

      await prisma.$transaction(ops);

      // Detecta qué productos quedaron bajo el umbral
      const updatedStock = await prisma.stock.findMany({
        where: { warehouseId, productId: { in: productIds } },
        include: { product: { select: { name: true, unit: true, reorderThreshold: true } } },
      });

      const lowStockAlerts = updatedStock
        .filter((s) => Number(s.quantity) <= s.product.reorderThreshold)
        .map((s) => `"${s.product.name}": ${Number(s.quantity)} ${s.product.unit} restantes`);

      res.status(201).json({
        dispatched: items.length,
        deliveredTo: { id: recipient.id, name: recipient.fullName },
        warehouse: warehouse.name,
        items: items.map((i) => ({
          productId: i.productId,
          productName: productMap[i.productId].name,
          unit: productMap[i.productId].unit,
          quantity: i.quantity,
        })),
        ...(lowStockAlerts.length > 0 && { stockAlerts: lowStockAlerts }),
      });
    } catch (err) {
      console.error('Batch movement error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

// GET /api/movements
// Historial con destinatario visible — acceso para manager y admin.
router.get(
  '/movements',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    query('warehouseId').optional().isUUID(),
    query('limit').optional().isInt({ min: 1, max: 200 }),
  ],
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);

      const movements = await prisma.movement.findMany({
        where: {
          warehouse: { orgId: req.user.orgId },
          ...(req.query.warehouseId && { warehouseId: req.query.warehouseId }),
        },
        include: {
          product:   { select: { name: true, unit: true } },
          warehouse: { select: { name: true } },
          performer: { select: { fullName: true } },
          recipient: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      res.json(movements.map((m) => ({
        id: m.id,
        type: m.type,
        quantity: Number(m.quantity),
        product: m.product.name,
        unit: m.product.unit,
        warehouse: m.warehouse.name,
        registeredBy: m.performer?.fullName ?? 'Sistema',
        deliveredTo: m.recipient?.fullName ?? null,
        notes: m.notes,
        createdAt: m.createdAt,
      })));
    } catch (err) {
      console.error('Movements list error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
