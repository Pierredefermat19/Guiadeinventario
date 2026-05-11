require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  const org = await prisma.organization.findUnique({
    where: { slug: 'comercial-san-cristobal' },
  });
  if (!org) throw new Error('Organización no encontrada. Corre seed.js primero.');

  const warehouse = await prisma.warehouse.findFirst({ where: { orgId: org.id } });

  const pin = '1234';
  const pinHash = await bcrypt.hash(pin, 12);

  const staff = await prisma.user.upsert({
    where: { email: 'auxiliar.test@san-cristobal.cl' },
    update: { pinHash, fullName: 'Juan Pérez (Test)' },
    create: {
      email: 'auxiliar.test@san-cristobal.cl',
      fullName: 'Juan Pérez (Test)',
      passwordHash: await bcrypt.hash('no-se-usa', 12),
      pinHash,
    },
  });

  await prisma.userOrganization.upsert({
    where: { userId_orgId: { userId: staff.id, orgId: org.id } },
    update: {},
    create: { userId: staff.id, orgId: org.id, role: 'staff' },
  });

  console.log(`Staff creado: ${staff.email}`);
  console.log(`  userId:      ${staff.id}`);
  console.log(`  warehouseId: ${warehouse.id}`);
  console.log(`  PIN:         ${pin}  ← cámbialo en producción`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
