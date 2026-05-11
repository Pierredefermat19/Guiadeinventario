const express = require('express');
const { query } = require('express-validator');
const { validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/inventory
// Dashboard completo: stock actual, alertas, movimientos recientes
// y comparación teórico vs real para detectar fugas.
router.get(
  '/inventory',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    query('warehouseId').optional().isUUID(),
    query('movementsLimit').optional().isInt({ min: 1, max: 100 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Parámetros inválidos' });

    const { warehouseId } = req.query;
    const movementsLimit = parseInt(req.query.movementsLimit ?? '20', 10);
    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const start7Days = new Date(now); start7Days.setDate(start7Days.getDate() - 7); start7Days.setHours(0, 0, 0, 0);

    try {
      const warehouseFilter = { orgId: req.user.orgId, ...(warehouseId && { id: warehouseId }) };

      // Stock, movimientos recientes y evidencias pendientes en paralelo
      const [stockRows, recentMovements, pendingPhotoTasks, completedTasksToday] =
        await Promise.all([
          prisma.stock.findMany({
            where: { warehouse: warehouseFilter },
            include: {
              product: {
                select: { id: true, name: true, sku: true, unit: true, reorderThreshold: true },
              },
              warehouse: { select: { id: true, name: true } },
            },
            orderBy: [{ warehouse: { name: 'asc' } }, { product: { name: 'asc' } }],
          }),

          prisma.movement.findMany({
            where: { warehouse: warehouseFilter },
            include: {
              product:   { select: { name: true, unit: true } },
              warehouse: { select: { name: true } },
              performer: { select: { fullName: true } },
              recipient: { select: { fullName: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: movementsLimit,
          }),

          prisma.task.findMany({
            where: { warehouse: warehouseFilter, status: 'completada_pendiente_foto' },
            select: {
              id: true, title: true, photoDeadline: true,
              user: { select: { fullName: true } },
              warehouse: { select: { name: true } },
            },
          }),

          // Tareas completadas hoy (para el resumen de consumo teórico)
          prisma.task.count({
            where: {
              warehouse: warehouseFilter,
              status: { in: ['completada', 'completada_pendiente_foto'] },
              completedAt: { gte: startOfDay },
            },
          }),
        ]);

      // Salidas reales 7d: total por producto + desglose por auxiliar
      const [salidas7d, salidasPorAuxiliar] = await Promise.all([
        prisma.movement.groupBy({
          by: ['productId'],
          where: { warehouse: warehouseFilter, type: 'salida', createdAt: { gte: start7Days } },
          _sum: { quantity: true },
        }),
        prisma.movement.findMany({
          where: {
            warehouse: warehouseFilter,
            type: 'salida',
            createdAt: { gte: start7Days },
            deliveredTo: { not: null },
          },
          select: {
            productId: true,
            quantity: true,
            deliveredTo: true,
            recipient: { select: { id: true, fullName: true } },
          },
        }),
      ]);

      const salidasMap = Object.fromEntries(
        salidas7d.map((s) => [s.productId, Number(s._sum.quantity ?? 0)]),
      );

      // Consumo teórico 7d: tareas completadas × consumo de template, agrupado por auxiliar
      const completedTasksWithTemplate = await prisma.task.findMany({
        where: {
          warehouse: warehouseFilter,
          status: { in: ['completada', 'completada_pendiente_foto'] },
          completedAt: { gte: start7Days },
          templateId: { not: null },
          assignedTo: { not: null },
        },
        select: {
          assignedTo: true,
          user: { select: { fullName: true } },
          template: { include: { consumptions: true } },
        },
      });

      // expectedMap[productId] = total teórico
      // expectedByAuxiliar[userId][productId] = teórico por esa persona
      const expectedMap = {};
      const expectedByAuxiliar = {};
      for (const task of completedTasksWithTemplate) {
        const uid = task.assignedTo;
        for (const c of task.template?.consumptions ?? []) {
          const pid = c.productId;
          const qty = Number(c.quantity);
          expectedMap[pid] = (expectedMap[pid] ?? 0) + qty;
          if (!expectedByAuxiliar[uid]) expectedByAuxiliar[uid] = { name: task.user?.fullName, products: {} };
          expectedByAuxiliar[uid].products[pid] = (expectedByAuxiliar[uid].products[pid] ?? 0) + qty;
        }
      }

      // entregadoByAuxiliar[userId][productId] = cantidad recibida
      const entregadoByAuxiliar = {};
      for (const m of salidasPorAuxiliar) {
        const uid = m.deliveredTo;
        const pid = m.productId;
        const qty = Number(m.quantity);
        if (!entregadoByAuxiliar[uid]) entregadoByAuxiliar[uid] = { name: m.recipient?.fullName, products: {} };
        entregadoByAuxiliar[uid].products[pid] = (entregadoByAuxiliar[uid].products[pid] ?? 0) + qty;
      }

      // Construye análisis de desfase por auxiliar (quién recibió vs quién consumió)
      const allUserIds = new Set([...Object.keys(expectedByAuxiliar), ...Object.keys(entregadoByAuxiliar)]);
      const desfasePorAuxiliar = Array.from(allUserIds).map((uid) => {
        const nombre = expectedByAuxiliar[uid]?.name ?? entregadoByAuxiliar[uid]?.name ?? 'Desconocido';
        const recibido = entregadoByAuxiliar[uid]?.products ?? {};
        const esperado = expectedByAuxiliar[uid]?.products ?? {};
        const allProducts = new Set([...Object.keys(recibido), ...Object.keys(esperado)]);

        return {
          userId: uid,
          auxiliar: nombre,
          productos: Array.from(allProducts).map((pid) => {
            const r = recibido[pid] ?? 0;
            const e = esperado[pid] ?? 0;
            const diff = parseFloat((r - e).toFixed(3));
            return {
              productId: pid,
              recibido: r,
              consumoEsperado: e,
              desfase_stock: diff,
              // Positivo: recibió más de lo que sus tareas justifican
              // Negativo: sus tareas justifican más de lo que recibió (usó stock previo)
              status: e === 0 ? 'sin_datos' : Math.abs(diff / e) < 0.2 ? 'ok' : diff > 0 ? 'exceso' : 'deficit',
            };
          }),
        };
      });

      const inventory = stockRows.map((s) => {
        const withdrawn = salidasMap[s.product.id] ?? 0;
        const expected  = expectedMap[s.product.id] ?? 0;
        const desfase   = parseFloat((withdrawn - expected).toFixed(3));

        return {
          warehouseId: s.warehouse.id,
          warehouseName: s.warehouse.name,
          productId: s.product.id,
          productName: s.product.name,
          sku: s.product.sku,
          unit: s.product.unit,
          quantity: Number(s.quantity),
          reorderThreshold: s.product.reorderThreshold,
          belowThreshold: Number(s.quantity) <= s.product.reorderThreshold,
          lastUpdated: s.lastUpdated,
          last7Days: {
            realWithdrawn: withdrawn,
            expectedConsumption: expected,
            desfase_stock: desfase,
            status: expected === 0 ? 'sin_datos'
              : Math.abs(desfase / expected) < 0.2 ? 'ok'
              : desfase > 0 ? 'exceso' : 'deficit',
          },
        };
      });

      res.json({
        generatedAt: now.toISOString(),
        summary: {
          totalProducts: inventory.length,
          belowThreshold: inventory.filter((i) => i.belowThreshold).length,
          pendingEvidences: pendingPhotoTasks.length,
          tasksCompletedToday: completedTasksToday,
        },

        // Círculo rojo en el dashboard — evidencias sin foto
        alerts: {
          pendingEvidences: pendingPhotoTasks.map((t) => ({
            taskId: t.id,
            title: t.title,
            assignedTo: t.user?.fullName ?? 'Sin asignar',
            warehouse: t.warehouse.name,
            photoDeadline: t.photoDeadline,
            isExpired: t.photoDeadline ? t.photoDeadline < now : false,
          })),
          lowStock: inventory
            .filter((i) => i.belowThreshold)
            .map((i) => ({
              productId: i.productId,
              productName: i.productName,
              quantity: i.quantity,
              reorderThreshold: i.reorderThreshold,
              unit: i.unit,
              warehouseName: i.warehouseName,
            })),
        },

        inventory,

        // Desfase por auxiliar: quién recibió vs quién justificó con tareas
        desfasePorAuxiliar,

        // Últimos N movimientos para el historial del admin
        recentMovements: recentMovements.map((m) => ({
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
        })),
      });
    } catch (err) {
      console.error('Inventory error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
