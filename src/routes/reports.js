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
          status: { in: ['completada', 'completada_sin_foto'] },
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


// GET /api/reports/export
// Descarga un Excel con 4 hojas: KPIs, Productividad, Inventario, Insights.
router.get(
  '/reports/export',
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

    const ExcelJS = require('exceljs');
    const { warehouseId, dateFrom, dateTo } = req.query;
    const orgId = req.user.orgId;

    const now = new Date();
    const from = dateFrom ? new Date(dateFrom) : new Date(now - 30 * 24 * 60 * 60 * 1000);
    const to   = dateTo   ? new Date(dateTo)   : now;

    const warehouseFilter = {
      warehouse: { orgId, ...(warehouseId && { id: warehouseId }) },
    };

    try {
      // ── Fetch all data in parallel ────────────────────────────────────────
      const [completedTasks, movements, stocks, warehouses] = await Promise.all([
        prisma.task.findMany({
          where: {
            ...warehouseFilter,
            status: { in: ['completada', 'completada_sin_foto'] },
            completedAt: { gte: from, lte: to },
            assignedTo: { not: null },
          },
          select: {
            assignedTo: true,
            startedAt: true,
            completedAt: true,
            status: true,
            user: { select: { fullName: true } },
            template: { include: { consumptions: true } },
          },
        }),
        prisma.movement.findMany({
          where: {
            ...warehouseFilter,
            createdAt: { gte: from, lte: to },
          },
          select: {
            type: true,
            quantity: true,
            productId: true,
            deliveredTo: true,
            product: { select: { name: true, unit: true } },
            recipient: { select: { fullName: true } },
            performer: { select: { fullName: true } },
            createdAt: true,
          },
        }),
        prisma.stock.findMany({
          where: { warehouse: { orgId, ...(warehouseId && { id: warehouseId }) } },
          include: {
            product: { select: { name: true, unit: true, reorderThreshold: true } },
            warehouse: { select: { name: true } },
          },
        }),
        prisma.warehouse.findMany({
          where: { orgId, ...(warehouseId && { id: warehouseId }) },
          select: { id: true, name: true },
        }),
      ]);

      // ── Derived aggregates ────────────────────────────────────────────────
      const fmtDate = (d) => d ? new Date(d).toLocaleDateString('es-CL') : '—';
      const fmtNum  = (n) => parseFloat(Number(n).toFixed(3));

      // Productivity per staff
      const staffMap = {};
      const ensureStaff = (uid, name) => {
        if (!staffMap[uid]) staffMap[uid] = {
          fullName: name ?? 'Desconocido',
          totalTasks: 0, withPhoto: 0, sinFoto: 0, durations: [],
          receivedByProduct: {}, expectedByProduct: {},
        };
      };

      for (const t of completedTasks) {
        const uid = t.assignedTo;
        ensureStaff(uid, t.user?.fullName);
        const s = staffMap[uid];
        s.totalTasks++;
        if (t.status === 'completada') s.withPhoto++;
        else s.sinFoto++;
        if (t.startedAt && t.completedAt) {
          const mins = (new Date(t.completedAt) - new Date(t.startedAt)) / 60000;
          if (mins > 0 && mins < 480) s.durations.push(mins);
        }
        for (const c of t.template?.consumptions ?? []) {
          const pid = c.productId;
          s.expectedByProduct[pid] = (s.expectedByProduct[pid] ?? 0) + Number(c.quantity);
        }
      }

      const salidas = movements.filter((m) => m.type === 'salida' && m.deliveredTo);
      for (const m of salidas) {
        const uid = m.deliveredTo;
        ensureStaff(uid, m.recipient?.fullName);
        const s = staffMap[uid];
        const pid = m.productId;
        if (!s.receivedByProduct[pid]) s.receivedByProduct[pid] = { name: m.product.name, unit: m.product.unit, qty: 0 };
        s.receivedByProduct[pid].qty += Number(m.quantity);
      }

      const staffRows = Object.values(staffMap).map((s) => {
        const avgMin = s.durations.length
          ? Math.round(s.durations.reduce((a, b) => a + b, 0) / s.durations.length) : null;
        const compliance = s.totalTasks > 0 ? Math.round((s.withPhoto / s.totalTasks) * 100) : null;
        const allPids = new Set([...Object.keys(s.receivedByProduct), ...Object.keys(s.expectedByProduct)]);
        const issues = Array.from(allPids).filter((pid) => {
          const rec = s.receivedByProduct[pid]?.qty ?? 0;
          const exp = s.expectedByProduct[pid] ?? 0;
          if (exp === 0) return false;
          return Math.abs((rec - exp) / exp) >= 0.2;
        }).length;
        return { fullName: s.fullName, totalTasks: s.totalTasks, withPhoto: s.withPhoto, sinFoto: s.sinFoto, avgMin, compliance, issues };
      }).sort((a, b) => b.totalTasks - a.totalTasks);

      // Movement breakdown per product
      const movByProduct = {};
      for (const m of movements) {
        const pid = m.productId;
        if (!movByProduct[pid]) movByProduct[pid] = { name: m.product.name, unit: m.product.unit, entrada: 0, salida: 0, ajuste: 0, transferencia: 0, merma: 0 };
        movByProduct[pid][m.type] = (movByProduct[pid][m.type] ?? 0) + Math.abs(Number(m.quantity));
      }

      // Inventory rows
      const inventoryRows = stocks.map((s) => {
        const qty = fmtNum(s.quantity);
        const threshold = Number(s.product.reorderThreshold);
        const ratio = threshold > 0 ? qty / threshold : null;
        const status = ratio === null ? 'Sin umbral' : ratio <= 0 ? 'Agotado' : ratio <= 1 ? 'Bajo mínimo' : ratio <= 1.5 ? 'Alerta' : 'OK';
        const mov = movByProduct[s.productId] ?? { entrada: 0, salida: 0, ajuste: 0, transferencia: 0, merma: 0 };
        return { warehouse: s.warehouse.name, product: s.product.name, unit: s.product.unit, qty, threshold, status, ...mov };
      }).sort((a, b) => {
        const order = { Agotado: 0, 'Bajo mínimo': 1, Alerta: 2, OK: 3, 'Sin umbral': 4 };
        return (order[a.status] ?? 5) - (order[b.status] ?? 5);
      });

      // KPI summary
      const totalTasks = completedTasks.length;
      const withPhoto  = completedTasks.filter((t) => t.status === 'completada').length;
      const photoCompliance = totalTasks > 0 ? Math.round((withPhoto / totalTasks) * 100) : 0;
      const allDurations = completedTasks
        .filter((t) => t.startedAt && t.completedAt)
        .map((t) => (new Date(t.completedAt) - new Date(t.startedAt)) / 60000)
        .filter((m) => m > 0 && m < 480);
      const avgDuration = allDurations.length
        ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length) : null;

      const mermaMovements = movements.filter((m) => m.type === 'merma');
      const totalMermaItems = mermaMovements.reduce((acc, m) => acc + Math.abs(Number(m.quantity)), 0);
      const mermaByProduct = {};
      for (const m of mermaMovements) {
        const k = m.product.name;
        if (!mermaByProduct[k]) mermaByProduct[k] = { unit: m.product.unit, qty: 0 };
        mermaByProduct[k].qty += Math.abs(Number(m.quantity));
      }

      const stockAlerts = inventoryRows.filter((r) => r.status === 'Bajo mínimo' || r.status === 'Agotado').length;
      const periodLabel = `${fmtDate(from)} — ${fmtDate(to)}`;
      const warehouseLabel = warehouses.map((w) => w.name).join(', ') || 'Todas';

      // ── Build workbook ────────────────────────────────────────────────────
      const wb = new ExcelJS.Workbook();
      wb.creator = 'Bodega SaaS';
      wb.created = now;

      const BRAND   = '2563EB'; // blue
      const GREEN   = '16A34A';
      const YELLOW  = 'CA8A04';
      const RED     = 'DC2626';
      const GRAY    = '6B7280';
      const BGLIGHT = 'EFF6FF';

      const hdrFill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + hex } });
      const hdrFont = (color = 'FFFFFFFF') => ({ bold: true, color: { argb: color }, size: 11 });
      const border  = () => ({
        top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      });

      const addHeaders = (ws, cols) => {
        ws.columns = cols;
        const hdrRow = ws.getRow(1);
        hdrRow.font = hdrFont();
        hdrRow.fill = hdrFill(BRAND);
        hdrRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        hdrRow.height = 30;
        hdrRow.eachCell((cell) => { cell.border = border(); });
      };

      const styleBand = (ws, startRow, color1 = 'FFF8FAFF', color2 = 'FFFFFFFF') => {
        ws.eachRow((row, rn) => {
          if (rn <= startRow) return;
          const fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rn % 2 === 0 ? color1 : color2 } };
          row.eachCell((cell) => {
            cell.fill = fill;
            cell.border = border();
            cell.alignment = { vertical: 'middle' };
          });
        });
      };

      // ── Sheet 1: KPIs ─────────────────────────────────────────────────────
      const s1 = wb.addWorksheet('📊 KPIs');
      s1.columns = [{ width: 36 }, { width: 22 }];

      const addKpi = (label, value, note) => {
        const r = s1.addRow([label, value]);
        r.getCell(1).font = { bold: true, color: { argb: 'FF374151' } };
        r.getCell(2).alignment = { horizontal: 'center' };
        r.getCell(2).font = { bold: true, size: 13 };
        r.eachCell((c) => { c.border = border(); });
        if (note) {
          const nr = s1.addRow(['', note]);
          nr.getCell(1).font = { italic: true, color: { argb: 'FF' + GRAY }, size: 10 };
          nr.getCell(2).font = { italic: true, color: { argb: 'FF' + GRAY }, size: 10 };
        }
      };

      const titleRow = s1.addRow(['Financial & Productivity Intelligence Report']);
      titleRow.font = { bold: true, size: 16, color: { argb: 'FF' + BRAND } };
      titleRow.getCell(1).alignment = { horizontal: 'left' };
      s1.addRow([]);

      addKpi('Período analizado', periodLabel);
      addKpi('Bodega(s)', warehouseLabel);
      s1.addRow([]);

      addKpi('Tareas completadas', totalTasks);
      addKpi('Auxiliares activos', staffRows.length);
      addKpi('Cumplimiento de foto', photoCompliance + '%',
        photoCompliance >= 80 ? '✅ Dentro del objetivo (≥80%)' : '⚠ Por debajo del objetivo (≥80%)');
      addKpi('Tiempo promedio por tarea', avgDuration ? avgDuration + ' min' : '—',
        avgDuration ? (avgDuration <= 30 ? '✅ Tiempo razonable' : '⚠ Puede indicar ineficiencia') : 'Sin datos suficientes');
      s1.addRow([]);

      addKpi('Productos con stock bajo mínimo', stockAlerts,
        stockAlerts === 0 ? '✅ Inventario en orden' : '🔴 Requiere reabastecimiento');
      addKpi('Registros de merma en el período', mermaMovements.length);
      addKpi('Cantidad total de merma', fmtNum(totalMermaItems) + ' uds (mixtas)');
      if (Object.keys(mermaByProduct).length > 0) {
        s1.addRow([]);
        const mrTitle = s1.addRow(['Detalle merma por producto', '']);
        mrTitle.getCell(1).font = { bold: true, color: { argb: 'FF' + RED } };
        for (const [name, d] of Object.entries(mermaByProduct)) {
          const mr = s1.addRow([`  • ${name}`, `${fmtNum(d.qty)} ${d.unit}`]);
          mr.eachCell((c) => { c.border = border(); });
        }
      }

      // ── Sheet 2: Productividad ────────────────────────────────────────────
      const s2 = wb.addWorksheet('👷 Productividad');
      addHeaders(s2, [
        { header: 'Auxiliar',               key: 'fullName',    width: 28 },
        { header: 'Tareas completadas',      key: 'totalTasks',  width: 18 },
        { header: 'Con foto',                key: 'withPhoto',   width: 14 },
        { header: 'Sin foto',                key: 'sinFoto',     width: 14 },
        { header: 'Cumpl. foto %',           key: 'compliance',  width: 16 },
        { header: 'Tiempo prom. (min)',       key: 'avgMin',      width: 18 },
        { header: 'Desfase insumos',         key: 'issues',      width: 18 },
      ]);

      for (const row of staffRows) {
        const r = s2.addRow({
          fullName:   row.fullName,
          totalTasks: row.totalTasks,
          withPhoto:  row.withPhoto,
          sinFoto:    row.sinFoto,
          compliance: row.compliance !== null ? row.compliance + '%' : '—',
          avgMin:     row.avgMin ?? '—',
          issues:     row.issues > 0 ? `⚠ ${row.issues} producto(s)` : '✅ OK',
        });
        // Color coding
        const compVal = row.compliance ?? 100;
        const compCell = r.getCell('compliance');
        compCell.font = { bold: true, color: { argb: compVal >= 80 ? 'FF' + GREEN : 'FF' + RED } };
        const issueCell = r.getCell('issues');
        issueCell.font = { color: { argb: row.issues > 0 ? 'FF' + RED : 'FF' + GREEN } };
      }
      styleBand(s2, 1);

      // ── Sheet 3: Inventario ───────────────────────────────────────────────
      const s3 = wb.addWorksheet('📦 Inventario');
      addHeaders(s3, [
        { header: 'Bodega',        key: 'warehouse',     width: 22 },
        { header: 'Producto',      key: 'product',       width: 28 },
        { header: 'Unidad',        key: 'unit',          width: 10 },
        { header: 'Stock actual',  key: 'qty',           width: 14 },
        { header: 'Umbral mínimo', key: 'threshold',     width: 16 },
        { header: 'Estado',        key: 'status',        width: 16 },
        { header: 'Entradas',      key: 'entrada',       width: 12 },
        { header: 'Salidas',       key: 'salida',        width: 12 },
        { header: 'Ajustes',       key: 'ajuste',        width: 12 },
        { header: 'Transferencias',key: 'transferencia', width: 16 },
        { header: 'Merma',         key: 'merma',         width: 12 },
      ]);

      const statusColor = { OK: GREEN, Alerta: YELLOW, 'Bajo mínimo': RED, Agotado: RED, 'Sin umbral': GRAY };

      for (const row of inventoryRows) {
        const r = s3.addRow(row);
        const statusCell = r.getCell('status');
        const hex = statusColor[row.status] ?? GRAY;
        statusCell.font = { bold: true, color: { argb: 'FF' + hex } };
        if (row.merma > 0) {
          r.getCell('merma').font = { bold: true, color: { argb: 'FF' + RED } };
        }
      }
      styleBand(s3, 1);

      // ── Sheet 4: Insights ejecutivos ──────────────────────────────────────
      const s4 = wb.addWorksheet('💡 Insights');
      s4.columns = [{ width: 6 }, { width: 80 }];

      const addSection = (title) => {
        const tr = s4.addRow(['', title]);
        tr.getCell(2).font = { bold: true, size: 13, color: { argb: 'FF' + BRAND } };
        tr.getCell(2).fill = hdrFill('EFF6FF');
        s4.addRow([]);
      };

      const addBullet = (icon, text, bold = false) => {
        const r = s4.addRow([icon, text]);
        r.getCell(2).font = bold
          ? { bold: true, color: { argb: 'FF111827' } }
          : { color: { argb: 'FF374151' } };
        r.getCell(2).alignment = { wrapText: true };
        r.height = 20;
      };

      s4.addRow([]);
      addSection('Resumen ejecutivo del período ' + periodLabel);

      // Tasks insight
      addBullet('📋', `Se completaron ${totalTasks} tarea(s) en el período con ${staffRows.length} auxiliar(es) activo(s).`);
      if (photoCompliance >= 80) {
        addBullet('✅', `Cumplimiento fotográfico: ${photoCompliance}% — dentro del objetivo mínimo del 80%.`);
      } else {
        addBullet('⚠️', `Cumplimiento fotográfico: ${photoCompliance}% — por debajo del objetivo (80%). Revisar con ${staffRows.filter((s) => (s.compliance ?? 100) < 80).map((s) => s.fullName).join(', ') || 'los auxiliares'}.`, true);
      }
      if (avgDuration) {
        addBullet(avgDuration <= 30 ? '⏱️' : '🐢',
          `Tiempo promedio por tarea: ${avgDuration} min. ${avgDuration > 30 ? 'Puede indicar tareas complejas o baja eficiencia.' : 'Tiempos dentro del rango esperado.'}`);
      }
      s4.addRow([]);

      // Inventory insights
      addSection('Estado del inventario');
      if (stockAlerts === 0) {
        addBullet('✅', 'Todos los productos están sobre el umbral mínimo. Sin necesidad de reabastecimiento urgente.');
      } else {
        const alertItems = inventoryRows.filter((r) => r.status === 'Bajo mínimo' || r.status === 'Agotado');
        addBullet('🔴', `${stockAlerts} producto(s) por debajo del umbral mínimo. Acción inmediata requerida:`, true);
        for (const item of alertItems.slice(0, 10)) {
          addBullet('  →', `${item.product} (${item.warehouse}): ${item.qty} ${item.unit} disponibles — umbral: ${item.threshold}`);
        }
      }
      s4.addRow([]);

      // Merma insights
      addSection('Merma (pérdidas / desperdicio)');
      if (mermaMovements.length === 0) {
        addBullet('✅', 'No se registraron mermas en el período. Excelente control de inventario.');
      } else {
        addBullet('⚠️', `Se registraron ${mermaMovements.length} movimiento(s) de merma en el período.`, true);
        for (const [name, d] of Object.entries(mermaByProduct)) {
          addBullet('  →', `${name}: ${fmtNum(d.qty)} ${d.unit} perdidos`);
        }
        addBullet('💡', 'Recomendación: investigar causas de merma y verificar condiciones de almacenamiento.');
      }
      s4.addRow([]);

      // Top performer
      if (staffRows.length > 0) {
        addSection('Destacados del período');
        const top = staffRows[0];
        addBullet('🏆', `Mayor cantidad de tareas: ${top.fullName} con ${top.totalTasks} tarea(s) completada(s).`);
        const bestPhoto = staffRows.filter((s) => s.compliance !== null).sort((a, b) => b.compliance - a.compliance)[0];
        if (bestPhoto) addBullet('📸', `Mejor cumplimiento fotográfico: ${bestPhoto.fullName} — ${bestPhoto.compliance}%.`);
        const withIssues = staffRows.filter((s) => s.issues > 0);
        if (withIssues.length > 0) {
          addBullet('⚠️', `Desfase de insumos detectado en: ${withIssues.map((s) => s.fullName).join(', ')}. Revisar entrega vs. consumo teórico.`, true);
        }
      }

      // ── Send response ─────────────────────────────────────────────────────
      const filename = `reporte_bodega_${fmtDate(from).replace(/\//g, '-')}_${fmtDate(to).replace(/\//g, '-')}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      await wb.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error('Export error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  },
);

module.exports = router;
