/** Explicit, one-time development credential provisioning; never exports prod credentials. */
import { PrismaClient } from '@goosey/postgresql-client';
import { randomBytes, publicEncrypt } from 'node:crypto';
const host = 'ep-misty-base-avzn246y-pooler.c-11.us-east-1.aws.neon.tech';
const branch = 'br-shy-sound-avbfzkbz';
let client: PrismaClient | undefined;
try {
  if (process.env.GOOSEY_PREPARE_DEV_BRANCH !== branch || process.env.NEON_PROJECT_ID !== 'round-mud-98593510') throw new Error('Destination mismatch');
  const source = new URL(process.env.POSTGRES_DATABASE_URL || process.env.NEON_DATABASE_URL || '');
  if (source.hostname === host || !source.hostname.endsWith('.neon.tech')) throw new Error('Production and development must differ');
  const publicKey = Buffer.from(process.env.GOOSEY_DEV_EXPORT_PUBLIC_KEY || '', 'base64').toString();
  // Validate the supplied encryption recipient before modifying the dev role.
  publicEncrypt({key:publicKey,oaepHash:'sha256'},Buffer.from('recipient-check'));
  source.hostname=host;
  client=new PrismaClient({datasources:{db:{url:source.toString()}},log:[]});
  const roles=await client.$queryRaw<Array<{rolname:string}>>`SELECT rolname FROM pg_roles WHERE rolname='goosey_local'`;
  if (roles.length) throw new Error('Development role already exists; do not rotate blindly');
  const counts={users:await client.user.count(),markets:await client.market.count()};
  if(counts.users<7 || counts.markets<12) throw new Error('Development snapshot is missing reviewed records');
  const password=randomBytes(24).toString('hex');
  await client.$transaction(async tx=>{
    // Identifier is a literal and password consists exclusively of random hex.
    await tx.$executeRawUnsafe(`CREATE ROLE goosey_local LOGIN PASSWORD '${password}'`);
    await tx.$executeRawUnsafe('GRANT CONNECT ON DATABASE neondb TO goosey_local');
    await tx.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO goosey_local');
    await tx.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO goosey_local');
    await tx.$executeRawUnsafe('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO goosey_local');
  });
  source.username='goosey_local';source.password=password;
  const check=new PrismaClient({datasources:{db:{url:source.toString()}},log:[]});
  try {if(await check.market.count()!==counts.markets)throw new Error('Development verification failed');}finally{await check.$disconnect();}
  const encrypted=publicEncrypt({key:publicKey,oaepHash:'sha256'},Buffer.from(JSON.stringify({url:source.toString(),secret:randomBytes(32).toString('hex')}))).toString('base64');
  console.log('GOOSEY_DEV_ENCRYPTED='+encrypted);
  console.log(JSON.stringify({developmentBranch:branch,host,role:'goosey_local',...counts,productionCredentialExported:false}));
} catch {
  // Prisma errors can embed a credential-bearing SQL statement. Never log them.
  console.error('Development credential setup failed. Inspect branch role existence before retrying; no credentials were printed.');
  process.exitCode=1;
} finally {await client?.$disconnect();}
