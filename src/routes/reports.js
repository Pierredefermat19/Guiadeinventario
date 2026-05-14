const express = require('express');
const { query, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/authenticate');
const prisma = require('../lib/prisma');

const router = express.Router();

// GET /api/reports/productivity
// Métricas de productividad por auxiliar en un rango de fechas.
// Incluye: tareas completadas, duración promedio, desfase de insumos (recibido vs. teórico).
router.get(
  '/reports/productivity',
  authenticate,
  requireRole('org_admin', 'warehouse_manager'),
  [
    query('warehouseId').optional().isUUID(),
    query('dateFrom').optional().isISO8601(),
    query('dateTo').optional().isISO8601(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Parámetros inválidos' });

    const { warehouseId, dateFrom, dateTo } = req.query;

    // Default: últimos 30 días
    const now = new Date();
    const from = dateFrom ? new Date(dateFrom) : new Date(now - 30 * 24 * 60 * 60 * 1000);
    const to   = dateTo   ? new Date(dateTo)   : now;

    const warehouseFilter = {
      warehouse: { orgId: req.user.orgId, ...(warehouseId && { id: warehouseId }) },
    };

    try {
      // Tareas completadas en el período
      const completedTasks = await prisma.task.findMany({
        where: {
          ...warehouseFilter,
          status: { in: ['completada', 'completada_pendiente_foto', 'completada_sin_foto'] },
          completedAt: { gte: from, lte: to },
          assignedTo: { not: null },
        },
        select: {
          assignedTo: true,
          startedAt: true,
          completedAt: true,
          status: true,
          afterPhotoRequired: true,
          templateId: true,
          user: { select: { fullName: true } },
          template: { include: { consumptions: true } },
        },
      });

      // Salidas entregadas a cada auxiliar en el período
      const salidas = await prisma.movement.findMany({
        where: {
          ...warehouseFilter,
          type: 'salida',
          createdAt: { gte: from, lte: to },
          deliveredTo: { not: null },
        },
        select: {
          deliveredTo: true,
          productId: true,
          quantity: true,
          product: { select: { name: true, unit: true } },
          recipient: { select: { fullName: true } },
        },
      });

      // Agrupa por auxiliar
      const staffMap = {};

      const ensureStaff = (userId, fullName) => {
        if (!staffMap[userId]) {
          staffMap[userId] = {
            userId,
            fullName: fullName ?? 'Desconocido',
            totalTasks: 0,
            tasksWithPhoto: 0,
            tasksSinFoto: 0,
            durations: [],
            receivedByProduct: {},
            expectedByProduct: {},
          };
        }
      };

      for (const t of completedTasks) {
        const uid = t.assignedTo;
        ensureStaff(uid, t.user?.fullName);
        const s = staffMap[uid];
        s.totalTasks++;

        if (t.status === 'completada') s.tasksWithPhoto++;
        if (t.status === 'completada_sin_foto') s.tasksSinFoto++;

        if (t.startedAt && t.completedAt) {
          const mins = (new Date(t.completedAt) - new Date(t.startedAt)) / 60000;
          if (mins > 0 && mins < 480) s.durations.push(mins); // ignora outliers >8h
        }

        // Consumo teórico acumulado
        for (const c of t.template?.consumptions ?? []) {
          const pid = c.productId;
          s.expectedByProduct[pid] = (s.expectedByProduct[pid] ?? 0) + Number(c.quantity);
        }
      }

      for (const m of salidas) {
        const uid = m.deliveredTo;
        ensureStaff(uid, m.recipient?.fullName);
        const s = staffMap[uid];
        const pid = m.productId;
        if (!s.receivedByProduct[pid]) {
          s.receivedByProduct[pid] = { name: m.product.name, unit: m.product.unit, qty: 0 };
        }
        s.receivedByProduct[pid].qty += Number(m.quantity);
      }

      // Construye respuesta
      const staff = Object.values(staffMap).map((s) => {
        const avgDuration = s.durations.length
          ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length)
          : null;

        const photoCompliance = s.totalTasks > 0
          ? Math.round((s.tasksWithPhoto / s.totalTasks) * 100)
          : null;

        // Desfase por producto: recibido - esperado
        const allPids = new Set([
          ...Object.keys(s.receivedByProduct),
          ...Object.keys(s.expectedByProduct),
        ]);

        const desfase = Array.from(allPids).map((pid) => {
          const rec  = s.receivedByProduct[pid]?.qty ?? 0;
          const exp  = s.expectedByProduct[pid] ?? 0;
          const diff = parseFloat((rec - exp).toFixed(3));
          const name = s.receivedByProduct[pid]?.name ?? `Producto ${pid.slice(0, 6)}`;
          const unit = s.receivedByProduct[pid]?.unit ?? '';
          return {
            productId: pid,
            product: name,
            unit,
            recibido: rec,
            esperado: exp,
            desfase: diff,
            status: exp === 0 ? 'sin_datos'
              : Math.abs(diff / exp) < 0.2 ? 'ok'
              : diff > 0 ? 'exceso' : 'deficit',
          };
        });

        const hasIssues = desfase.some((d) => d.status === 'exceso' || d.status === 'deficit');

        return {
          userId: s.userId,
          fullName: s.fullName,
          totalTasks: s.totalTasks,
          tasksWithPhoto: s.tasksWithPhoto,
          tasksSinFoto: s.tasksSinFoto,
          avgDurationMinutes: avgDuration,
          photoCompliance,
          desfase,
          hasIssues,
        };
      });

      // Ordena: con issues primero, luego por totalTasks desc
      staff.sort((a, b) => {
        if (a.hasIssues !== b.hasIssues) return a.hasIssues ? -1 : 1;
        return b.totalTasks - a.totalTasks;
      });

      res.json({
        period: { from: from.toISOString(), to: to.toISOString() },
        warehouseId: warehouseId ?? null,
        totalStaff: staff.length,
        staff,
      });
    } catch (err) {
      console.error('Productivity report error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
