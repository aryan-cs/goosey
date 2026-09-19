import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";
import { getAddressDecoder } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "@/lib/security";
import { hashPassword } from "@/lib/auth";
import type { TransactionRunner } from "@/lib/serializable-transaction";
import {
  consumeWalletLinkChallenge,
  issueWalletLinkChallenge as issueWithPassword,
  resolveWalletLinkConfiguration,
  WalletLinkError,
  type IssuedWalletLinkChallenge,
  type WalletLinkAuthentication,
  type WalletLinkConfiguration,
} from "@/lib/solana/wallet-link-service";

import { DEVNET_GENESIS_HASH as GENESIS } from "./runtime";
const CONFIGURATION: WalletLinkConfiguration = {
  origin: "https://goosey.example",
  chainId: "solana:devnet",
  genesisHash: GENESIS,
};
const PASSWORD = "Wallet-link-test-password-42!";
const issueWalletLinkChallenge = (input: Omit<Parameters<typeof issueWithPassword>[0], "password"> & { password?: string }, client: Parameters<typeof issueWithPassword>[1]) =>
  issueWithPassword({ password: PASSWORD, ...input }, client);

function wallet() {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const address = getAddressDecoder().decode(new Uint8Array(spki.subarray(spki.length - 32)));
  return {
    address,
    sign(message: string) {
      return sign(null, Buffer.from(message, "utf8"), pair.privateKey).toString("base64");
    },
  };
}

function completion(
  authentication: WalletLinkAuthentication,
  issued: IssuedWalletLinkChallenge,
  signer: ReturnType<typeof wallet>,
  now: Date,
) {
  return {
    authentication,
    configuration: CONFIGURATION,
    challengeId: issued.id,
    challenge: issued.challenge,
    signedMessageBase64: Buffer.from(issued.challenge.message, "utf8").toString("base64"),
    signatureBase64: signer.sign(issued.challenge.message),
    now,
  };
}

describe("durable Solana wallet links", () => {
  const directory = mkdtempSync(join(tmpdir(), "goosey-wallet-link-"));
  const databasePath = join(directory, "wallet-links.db");
  const databaseUrl = `file:${databasePath}`;
  const database = new PrismaClient({ datasourceUrl: databaseUrl });
  let sequence = 0;
  let passwordHash: string;

  async function account(now = new Date()) {
    sequence += 1;
    const token = `wallet-link-session-${sequence}`;
    const user = await database.user.create({
      data: {
        email: `wallet-link-${sequence}@example.com`,
        username: `wallet_link_${sequence}`,
        displayName: `Wallet Link ${sequence}`,
        passwordHash,
        emailVerifiedAt: now,
      },
      select: { id: true },
    });
    const session = await database.session.create({
      data: {
        userId: user.id,
        tokenHash: sha256(token),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
      },
      select: { id: true },
    });
    return {
      userId: user.id,
      sessionId: session.id,
      token,
      authentication: { userId: user.id, sessionToken: token },
    };
  }

  beforeAll(async () => {
    passwordHash = await hashPassword(PASSWORD);
    const schemaSql = execFileSync(
      join(process.cwd(), "node_modules/.bin/prisma"),
      ["migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_PROVIDER: "sqlite" },
        stdio: "pipe",
        timeout: 20_000,
        encoding: "utf8",
      },
    );
    execFileSync("sqlite3", [databasePath], { input: schemaSql, stdio: ["pipe", "pipe", "pipe"], timeout: 20_000 });
    await database.$connect();
  }, 30_000);

  it("derives origin and chain identity only from fail-closed server configuration", () => {
    const program = wallet().address;
    expect(resolveWalletLinkConfiguration({
      NODE_ENV: "test",
      APP_URL: "http://127.0.0.1:8080",
      GOOSEY_SOLANA_CLUSTER: "localnet",
      GOOSEY_SOLANA_RPC_URL: "http://127.0.0.1:18999",
      GOOSEY_SOLANA_PROGRAM_ID: program,
      GOOSEY_SOLANA_GENESIS_HASH: "11111111111111111111111111111111",
    })).toEqual({
      origin: "http://127.0.0.1:8080",
      chainId: "solana:localnet",
      genesisHash: "11111111111111111111111111111111",
    });
    expect(() => resolveWalletLinkConfiguration({
      NODE_ENV: "production",
      APP_URL: "http://goosey.example",
      GOOSEY_SOLANA_CLUSTER: "devnet",
      GOOSEY_SOLANA_RPC_URL: "https://api.devnet.solana.com",
      GOOSEY_SOLANA_PROGRAM_ID: program,
    })).toThrow("HTTPS APP_URL");
  });

  afterAll(async () => {
    await database.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists a short-lived challenge bound to the authenticated user and exact session", async () => {
    const now = new Date("2026-09-19T18:00:00.000Z");
    const actor = await account(now);
    const signer = wallet();

    const issued = await issueWalletLinkChallenge({
      authentication: actor.authentication,
      configuration: CONFIGURATION,
      walletAddress: signer.address,
      now,
    }, database);

    const stored = await database.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } });
    expect(stored).toMatchObject({
      userId: actor.userId,
      sessionId: actor.sessionId,
      purpose: "LINK_WALLET_REAUTH_V1",
      origin: CONFIGURATION.origin,
      chainId: CONFIGURATION.chainId,
      genesisHash: CONFIGURATION.genesisHash,
      walletAddress: signer.address,
      consumedAt: null,
    });
    expect(stored.nonceHash).toBe(sha256(issued.challenge.nonce));
    expect(stored.messageHash).toBe(sha256(issued.challenge.message));
    expect(JSON.stringify(stored)).not.toContain(issued.challenge.nonce);
  });

  it("atomically consumes a valid signature and creates only an identity association", async () => {
    const now = new Date("2026-09-19T18:10:00.000Z");
    const actor = await account(now);
    const signer = wallet();
    const issued = await issueWalletLinkChallenge({
      authentication: actor.authentication,
      configuration: CONFIGURATION,
      walletAddress: signer.address,
      now,
    }, database);

    const linked = await consumeWalletLinkChallenge(
      completion(actor.authentication, issued, signer, new Date(now.getTime() + 1_000)),
      database,
    );

    expect(linked.wallet).toMatchObject({
      userId: actor.userId,
      chainId: CONFIGURATION.chainId,
      genesisHash: CONFIGURATION.genesisHash,
      walletAddress: signer.address,
      verifiedAt: new Date(now.getTime() + 1_000),
    });
    expect((await database.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt)
      .toEqual(new Date(now.getTime() + 1_000));
    expect(await database.journalEntry.count({ where: { actorUserId: actor.userId } })).toBe(0);
    expect((await database.user.findUniqueOrThrow({ where: { id: actor.userId } })).balanceMilli).toBe(0n);
    expect(await database.session.findUnique({ where: { id: actor.sessionId } })).toBeNull();
    expect(await database.session.findUnique({ where: { tokenHash: sha256(linked.session.token) } })).toMatchObject({ userId: actor.userId });
    expect((await database.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt)
      .toEqual(new Date(now.getTime() + 1_000));
  });

  it("rejects a challenge from another current session without consuming it", async () => {
    const now = new Date("2026-09-19T18:20:00.000Z");
    const actor = await account(now);
    const signer = wallet();
    const issued = await issueWalletLinkChallenge({
      authentication: actor.authentication,
      configuration: CONFIGURATION,
      walletAddress: signer.address,
      now,
    }, database);
    const otherToken = "same-user-other-session";
    await database.session.create({
      data: {
        userId: actor.userId,
        tokenHash: sha256(otherToken),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1_000),
      },
    });

    await expect(consumeWalletLinkChallenge(
      completion(
        { userId: actor.userId, sessionToken: otherToken },
        issued,
        signer,
        new Date(now.getTime() + 1_000),
      ),
      database,
    )).rejects.toMatchObject({ code: "INVALID_CHALLENGE" });
    expect((await database.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt).toBeNull();
  });

  it("allows exactly one concurrent consumer and rejects replay", async () => {
    const now = new Date("2026-09-19T18:30:00.000Z");
    const actor = await account(now);
    const signer = wallet();
    const issued = await issueWalletLinkChallenge({
      authentication: actor.authentication,
      configuration: CONFIGURATION,
      walletAddress: signer.address,
      now,
    }, database);
    const request = completion(actor.authentication, issued, signer, new Date(now.getTime() + 1_000));

    const results = await Promise.allSettled([
      consumeWalletLinkChallenge(request, database),
      consumeWalletLinkChallenge(request, database),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(WalletLinkError);
    expect(["CHALLENGE_ALREADY_USED", "AUTHENTICATION_REQUIRED"]).toContain((rejected?.reason as WalletLinkError).code);
    expect(await database.solanaWalletLink.count({ where: { userId: actor.userId } })).toBe(1);

    await expect(consumeWalletLinkChallenge(request, database)).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });
  });

  it("rolls back nonce consumption when the wallet identity belongs to another account", async () => {
    const now = new Date("2026-09-19T18:40:00.000Z");
    const signer = wallet();
    const first = await account(now);
    const firstChallenge = await issueWalletLinkChallenge({
      authentication: first.authentication,
      configuration: CONFIGURATION,
      walletAddress: signer.address,
      now,
    }, database);
    await consumeWalletLinkChallenge(
      completion(first.authentication, firstChallenge, signer, new Date(now.getTime() + 1_000)),
      database,
    );

    const second = await account(now);
    const secondChallenge = await issueWalletLinkChallenge({
      authentication: second.authentication,
      configuration: CONFIGURATION,
      walletAddress: signer.address,
      now,
    }, database);
    await expect(consumeWalletLinkChallenge(
      completion(second.authentication, secondChallenge, signer, new Date(now.getTime() + 2_000)),
      database,
    )).rejects.toMatchObject({ code: "WALLET_LINK_CONFLICT" });

    expect((await database.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: secondChallenge.id } })).consumedAt)
      .toBeNull();
    expect(await database.solanaWalletLink.count({ where: { walletAddress: signer.address } })).toBe(1);
    expect(await database.session.findUnique({where:{id:second.sessionId}})).not.toBeNull();
    expect(await database.session.count({where:{userId:second.userId}})).toBe(1);
  });

  it("rejects changed deployment configuration, signatures, and expiration without consuming", async () => {
    const now = new Date("2026-09-19T18:50:00.000Z");
    const actor = await account(now);
    const signer = wallet();
    const issued = await issueWalletLinkChallenge({
      authentication: actor.authentication,
      configuration: CONFIGURATION,
      walletAddress: signer.address,
      now,
    }, database);

    await expect(consumeWalletLinkChallenge({
      ...completion(actor.authentication, issued, signer, new Date(now.getTime() + 1_000)),
      configuration: { ...CONFIGURATION, chainId: "solana:localnet" },
    }, database)).rejects.toMatchObject({ code: "INVALID_CHALLENGE" });
    await expect(consumeWalletLinkChallenge({
      ...completion(actor.authentication, issued, signer, new Date(now.getTime() + 1_000)),
      signatureBase64: wallet().sign(issued.challenge.message),
    }, database)).rejects.toMatchObject({ code: "INVALID_CHALLENGE" });
    await expect(consumeWalletLinkChallenge(
      completion(actor.authentication, issued, signer, new Date(issued.challenge.expirationTime)),
      database,
    )).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });

    expect((await database.solanaWalletLinkChallenge.findUniqueOrThrow({ where: { id: issued.id } })).consumedAt).toBeNull();
  });
  it("requires the current password even for a newly issued session and stores no password", async () => {
    const actor=await account(), signer=wallet();
    const input={authentication:actor.authentication,configuration:CONFIGURATION,walletAddress:signer.address};
    for(const password of ["wrong-password-123!", "", undefined]) {
      await expect(issueWithPassword({...input,password:password as string},database)).rejects.toMatchObject({code:"REAUTHENTICATION_REQUIRED"});
    }
    expect(await database.solanaWalletLinkChallenge.count({where:{userId:actor.userId}})).toBe(0);
    const issued=await issueWalletLinkChallenge(input,database);
    expect(JSON.stringify(issued)).not.toContain(PASSWORD);
    expect(JSON.stringify(await database.solanaWalletLinkChallenge.findUnique({where:{id:issued.id}}))).not.toContain(PASSWORD);
  });
  it.each(["password-change","session-revocation"])("rejects %s between password snapshot and challenge transaction",async race=>{
    const actor=await account(),signer=wallet();let calls=0;
    const racing:TransactionRunner={$transaction:async(operation,options)=>{
      if(++calls===2) {
        if(race==="password-change") await database.user.update({where:{id:actor.userId},data:{passwordHash:await hashPassword("Changed-password-456!")}});
        else await database.session.delete({where:{id:actor.sessionId}});
      }
      return database.$transaction(operation,options);
    }};
    await expect(issueWalletLinkChallenge({authentication:actor.authentication,configuration:CONFIGURATION,walletAddress:signer.address},racing)).rejects.toMatchObject({code:race==="password-change"?"REAUTHENTICATION_REQUIRED":"AUTHENTICATION_REQUIRED"});
    expect(await database.solanaWalletLinkChallenge.count({where:{userId:actor.userId}})).toBe(0);
  });
  it("does not accept legacy non-reauthenticated challenges",async()=>{
    const actor=await account(),signer=wallet(),now=new Date();
    const issued=await issueWalletLinkChallenge({authentication:actor.authentication,configuration:CONFIGURATION,walletAddress:signer.address,now},database);
    await database.solanaWalletLinkChallenge.update({where:{id:issued.id},data:{purpose:"LINK_WALLET"}});
    await expect(consumeWalletLinkChallenge(completion(actor.authentication,issued,signer,now),database)).rejects.toMatchObject({code:"INVALID_CHALLENGE"});
    expect(await database.session.findUnique({where:{id:actor.sessionId}})).not.toBeNull();
  });
  it("rotation invalidates sibling challenges and never replaces password reauthentication",async()=>{
    const actor=await account(),signer=wallet(),now=new Date();
    const input={authentication:actor.authentication,configuration:CONFIGURATION,walletAddress:signer.address,now};
    const first=await issueWalletLinkChallenge(input,database),sibling=await issueWalletLinkChallenge(input,database);
    const linked=await consumeWalletLinkChallenge(completion(actor.authentication,first,signer,now),database);
    const rotated={userId:actor.userId,sessionToken:linked.session.token};
    await expect(consumeWalletLinkChallenge(completion(rotated,sibling,signer,now),database)).rejects.toMatchObject({code:"INVALID_CHALLENGE"});
    await expect(consumeWalletLinkChallenge(completion(actor.authentication,sibling,signer,now),database)).rejects.toMatchObject({code:"AUTHENTICATION_REQUIRED"});
    await expect(issueWithPassword({...input,authentication:rotated,password:"wrong-password-123!"},database)).rejects.toMatchObject({code:"REAUTHENTICATION_REQUIRED"});
    expect(await database.solanaWalletLinkChallenge.findUnique({where:{id:first.id}})).toMatchObject({sessionId:actor.sessionId,consumedAt:now});
  });
  it("rolls back link, nonce, and replacement session if old-session revocation fails",async()=>{
    const actor=await account(),signer=wallet(),now=new Date();
    const issued=await issueWalletLinkChallenge({authentication:actor.authentication,configuration:CONFIGURATION,walletAddress:signer.address,now},database);
    // Failure injection only into this test's isolated SQLite database.
    await database.$executeRawUnsafe('CREATE TRIGGER fail_wallet_rotation BEFORE DELETE ON "Session" BEGIN SELECT RAISE(ABORT, \'rotation failure\'); END');
    try {await expect(consumeWalletLinkChallenge(completion(actor.authentication,issued,signer,now),database)).rejects.toThrow();}
    finally {await database.$executeRawUnsafe('DROP TRIGGER fail_wallet_rotation');}
    expect(await database.solanaWalletLink.count({where:{userId:actor.userId}})).toBe(0);
    expect(await database.session.count({where:{userId:actor.userId}})).toBe(1);
    expect(await database.session.findUnique({where:{id:actor.sessionId}})).not.toBeNull();
    expect(await database.solanaWalletLinkChallenge.findUnique({where:{id:issued.id}})).toMatchObject({consumedAt:null});
  });
});
