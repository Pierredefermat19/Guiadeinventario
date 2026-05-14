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
    body('deliveredTo').optional({ nullable: true }).isUUID(),
    body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
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

      let movement;
      try {
        movement = await prisma.$transaction(async (tx) => {
          const delta = type === 'salida' ? -qty : qty;

          if (type === 'salida') {
            const currentStock = await tx.stock.findUnique({
              where: { warehouseId_productId: { warehouseId, productId } },
            });
            const currentQty = Number(currentStock?.quantity ?? 0);
            if (currentQty < qty) {
              const err = new Error('INSUFFICIENT_STOCK');
              err.currentQty = currentQty;
              throw err;
            }
          }

          const mov = await tx.movement.create({
            data: { warehouseId, productId, type, quantity: qty, notes, performedBy: req.user.userId, deliveredTo },
          });
          await tx.stock.upsert({
            where: { warehouseId_productId: { warehouseId, productId } },
            create: { warehouseId, productId, quantity: delta, lastUpdated: new Date() },
            update: { quantity: { increment: delta }, lastUpdated: new Date() },
          });
          return mov;
        });
      } catch (txErr) {
        if (txErr.message === 'INSUFFICIENT_STOCK') {
          return res.status(409).json({
            error: `Stock insuficiente. Disponible: ${txErr.currentQty} ${product.unit}`,
          });
        }
        throw txErr;
      }

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
    body('items.*.notes').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
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

      const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

      // Verifica stock y ejecuta todos los movimientos en una sola transacción atómica
      try {
        await prisma.$transaction(async (tx) => {
          const now = new Date();
          const stockErrors = [];

          for (const item of items) {
            const stock = await tx.stock.findUnique({
              where: { warehouseId_productId: { warehouseId, productId: item.productId } },
            });
            const available = Number(stock?.quantity ?? 0);
            if (available < item.quantity) {
              const p = productMap[item.productId];
              stockErrors.push(`"${p.name}": disponible ${available} ${p.unit}, pedido ${item.quantity}`);
            }
          }

          if (stockErrors.length > 0) {
            const err = new Error('INSUFFICIENT_STOCK');
            err.details = stockErrors;
            throw err;
          }

          for (const item of items) {
            await tx.movement.create({
              data: {
                warehouseId,
                productId: item.productId,
                type: 'salida',
                quantity: item.quantity,
                notes: item.notes ?? null,
                performedBy: req.user.userId,
                deliveredTo,
              },
            });
            await tx.stock.upsert({
              where: { warehouseId_productId: { warehouseId, productId: item.productId } },
              create: { warehouseId, productId: item.productId, quantity: -item.quantity, lastUpdated: now },
              update: { quantity: { increment: -item.quantity }, lastUpdated: now },
            });
          }
        });
      } catch (txErr) {
        if (txErr.message === 'INSUFFICIENT_STOCK') {
          return res.status(409).json({ error: 'Stock insuficiente para algunos productos', details: txErr.details });
        }
        throw txErr;
      }

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

// POST /api/movements/transfer
// Mueve stock de una bodega a otra dentro de la misma organización.
// Crea dos registros de movimiento enlazados por una referencia en el campo notes.
router.post(
  '/movements/transfer',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    body('fromWarehouseId').isUUID(),
    body('toWarehouseId').isUUID(),
    body('productId').isUUID(),
    body('quantity').isFloat({ gt: 0 }),
    body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos', details: errors.array() });

    const { fromWarehouseId, toWarehouseId, productId, quantity, notes } = req.body;
    const qty = parseFloat(quantity);

    if (fromWarehouseId === toWarehouseId) {
      return res.status(400).json({ error: 'La bodega de origen y destino deben ser distintas' });
    }

    try {
      const [fromWh, toWh, product] = await Promise.all([
        prisma.warehouse.findFirst({ where: { id: fromWarehouseId, orgId: req.user.orgId } }),
        prisma.warehouse.findFirst({ where: { id: toWarehouseId,   orgId: req.user.orgId } }),
        prisma.product.findFirst(  { where: { id: productId,       orgId: req.user.orgId } }),
      ]);
      if (!fromWh)  return res.status(404).json({ error: 'Bodega de origen no encontrada' });
      if (!toWh)    return res.status(404).json({ error: 'Bodega de destino no encontrada' });
      if (!product) return res.status(404).json({ error: 'Producto no encontrado' });

      const ref = require('crypto').randomBytes(3).toString('hex').toUpperCase();
      const movNotes = `[Transf.${ref}]${notes ? ' ' + notes : ''}`;

      try {
        await prisma.$transaction(async (tx) => {
          const srcStock = await tx.stock.findUnique({
            where: { warehouseId_productId: { warehouseId: fromWarehouseId, productId } },
          });
          const available = Number(srcStock?.quantity ?? 0);
          if (available < qty) {
            const err = new Error('INSUFFICIENT_STOCK');
            err.available = available;
            throw err;
          }

          await tx.movement.create({
            data: { warehouseId: fromWarehouseId, productId, type: 'transferencia',
                    quantity: qty, notes: movNotes, performedBy: req.user.userId },
          });
          await tx.movement.create({
            data: { warehouseId: toWarehouseId, productId, type: 'transferencia',
                    quantity: qty, notes: movNotes, performedBy: req.user.userId },
          });
          await tx.stock.upsert({
            where: { warehouseId_productId: { warehouseId: fromWarehouseId, productId } },
            create: { warehouseId: fromWarehouseId, productId, quantity: -qty, lastUpdated: new Date() },
            update: { quantity: { increment: -qty }, lastUpdated: new Date() },
          });
          await tx.stock.upsert({
            where: { warehouseId_productId: { warehouseId: toWarehouseId, productId } },
            create: { warehouseId: toWarehouseId, productId, quantity: qty, lastUpdated: new Date() },
            update: { quantity: { increment: qty },  lastUpdated: new Date() },
          });
        });
      } catch (txErr) {
        if (txErr.message === 'INSUFFICIENT_STOCK') {
          return res.status(409).json({
            error: `Stock insuficiente en "${fromWh.name}". Disponible: ${txErr.available} ${product.unit}`,
          });
        }
        throw txErr;
      }

      res.status(201).json({
        ref,
        product: { id: productId, name: product.name, unit: product.unit },
        quantity: qty,
        from: fromWh.name,
        to: toWh.name,
      });
    } catch (err) {
      console.error('Transfer error:', err);
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
