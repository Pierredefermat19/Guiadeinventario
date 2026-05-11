require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('Iniciando seed...');

  const org = await prisma.organization.upsert({
    where: { slug: 'comercial-san-cristobal' },
    update: {},
    create: {
      name: 'Comercial San Cristóbal',
      slug: 'comercial-san-cristobal',
      plan: 'pro',
    },
  });
  console.log(`Organización creada: ${org.name} (${org.id})`);

  let warehouse = await prisma.warehouse.findFirst({
    where: { orgId: org.id, name: 'Bodega Principal' },
  });
  if (!warehouse) {
    warehouse = await prisma.warehouse.create({
      data: { orgId: org.id, name: 'Bodega Principal', location: 'Planta baja, ala norte' },
    });
  }
  console.log(`Bodega: ${warehouse.name} (${warehouse.id})`);

  const passwordHash = await bcrypt.hash('Admin1234!', 12);

  const admin = await prisma.user.upsert({
    where: { email: 'palmacaceresnicolas19@gmail.com' },
    update: { fullName: 'Nicolás Palma' },
    create: {
      email: 'palmacaceresnicolas19@gmail.com',
      fullName: 'Nicolás Palma',
      passwordHash,
    },
  });
  console.log(`Usuario creado: ${admin.email} (${admin.id})`);

  await prisma.userOrganization.upsert({
    where: { userId_orgId: { userId: admin.id, orgId: org.id } },
    update: {},
    create: {
      userId: admin.id,
      orgId: org.id,
      role: 'org_admin',
    },
  });
  console.log('Rol org_admin asignado.');

  console.log('\n✓ Seed completado. Contraseña inicial: Admin1234!');
  console.log('  → Cámbiala desde el panel antes de dar acceso a nadie más.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
