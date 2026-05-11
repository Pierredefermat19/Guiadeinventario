require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.findUnique({
    where: { slug: 'comercial-san-cristobal' },
  });
  if (!org) throw new Error('Corre seed.js primero.');

  const warehouse = await prisma.warehouse.findFirst({
    where: { orgId: org.id },
  });
  if (!warehouse) throw new Error('No hay bodega. Corre seed.js primero.');

  // ── Productos ────────────────────────────────────────────────────────────
  const cloro = await prisma.product.upsert({
    where: { orgId_sku: { orgId: org.id, sku: 'CLORO-5L' } },
    update: {},
    create: { orgId: org.id, name: 'Cloro concentrado 5L', sku: 'CLORO-5L', unit: 'litro', reorderThreshold: 10 },
  });

  const escoba = await prisma.product.upsert({
    where: { orgId_sku: { orgId: org.id, sku: 'ESCOBA-01' } },
    update: {},
    create: { orgId: org.id, name: 'Escoba industrial', sku: 'ESCOBA-01', unit: 'unidad', reorderThreshold: 3 },
  });

  const desinfectante = await prisma.product.upsert({
    where: { orgId_sku: { orgId: org.id, sku: 'DESINF-1L' } },
    update: {},
    create: { orgId: org.id, name: 'Desinfectante 1L', sku: 'DESINF-1L', unit: 'litro', reorderThreshold: 5 },
  });

  console.log('Productos creados:', cloro.name, '|', escoba.name, '|', desinfectante.name);

  // ── Stock inicial ─────────────────────────────────────────────────────────
  for (const [product, qty] of [[cloro, 24], [escoba, 2], [desinfectante, 8]]) {
    await prisma.stock.upsert({
      where: { warehouseId_productId: { warehouseId: warehouse.id, productId: product.id } },
      update: {},
      create: { warehouseId: warehouse.id, productId: product.id, quantity: qty },
    });
  }
  console.log('Stock cargado. Escoba en 2 (bajo mínimo 3) → debería aparecer alerta.');

  // ── Template de tarea ─────────────────────────────────────────────────────
  let template = await prisma.taskTemplate.findFirst({
    where: { warehouseId: warehouse.id, title: 'Limpieza de baños' },
  });
  if (!template) {
    template = await prisma.taskTemplate.create({
      data: {
        warehouseId: warehouse.id,
        title: 'Limpieza de baños',
        description: 'Limpieza profunda de baños: pisos, azulejos, inodoros y lavamanos.',
        cronExpr: '0 8 * * 1-5',
      },
    });
  }

  await prisma.taskTemplateConsumption.upsert({
    where: { templateId_productId: { templateId: template.id, productId: cloro.id } },
    update: { quantity: 0.5 },
    create: { templateId: template.id, productId: cloro.id, quantity: 0.5 },
  });

  await prisma.taskTemplateConsumption.upsert({
    where: { templateId_productId: { templateId: template.id, productId: desinfectante.id } },
    update: { quantity: 0.2 },
    create: { templateId: template.id, productId: desinfectante.id, quantity: 0.2 },
  });

  console.log('Template creado:', template.title);

  // ── Tareas de hoy ─────────────────────────────────────────────────────────
  const today = new Date();
  today.setHours(8, 0, 0, 0);

  const existingTasks = await prisma.task.count({
    where: {
      warehouseId: warehouse.id,
      scheduledFor: { gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()) },
    },
  });

  if (existingTasks === 0) {
    await prisma.task.createMany({
      data: [
        {
          warehouseId: warehouse.id,
          templateId: template.id,
          title: 'Limpieza de baños — Bloque A',
          description: 'Baños planta baja, ala norte.',
          status: 'disponible',
          scheduledFor: today,
        },
        {
          warehouseId: warehouse.id,
          templateId: template.id,
          title: 'Limpieza de baños — Bloque B',
          description: 'Baños segundo piso.',
          status: 'disponible',
          scheduledFor: today,
        },
        {
          warehouseId: warehouse.id,
          title: 'Reposición de papel higiénico',
          description: 'Revisar y reponer dispensadores en todos los baños.',
          status: 'disponible',
          scheduledFor: today,
          afterPhotoRequired: false,
        },
      ],
    });
    console.log('3 tareas creadas para hoy.');
  } else {
    console.log(`Ya hay ${existingTasks} tarea(s) para hoy — no se duplicaron.`);
  }

  console.log('\n✓ seed-demo completado.');
  console.log(`  Bodega: ${warehouse.id}`);
  console.log(`  URL PWA: http://localhost:3000/?wh=${warehouse.id}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
