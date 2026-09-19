import { Buffer } from "node:buffer";
import type { Socket } from "node:net";
import { createServer, type Server, type TLSSocket } from "node:tls";

const HOST = "127.0.0.1";
const MAX_CONNECTIONS = 8;
const MAX_LINE_BYTES = 998;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_RECIPIENTS = 100;
const MAX_MESSAGES = 100;
const SOCKET_TIMEOUT_MS = 10_000;

export type TestSmtpMessage = {
  recipients: string[];
  raw: string;
};

export type TestSmtpReceiver = {
  port: number;
  messages: TestSmtpMessage[];
  rejectDelivery: boolean;
  close(): Promise<void>;
};

type SmtpSession = {
  greeted: boolean;
  mailFrom: boolean;
  recipients: string[];
  dataMode: boolean;
  dataChunks: Buffer[];
  dataBytes: number;
  pending: Buffer;
};

function reply(socket: TLSSocket, line: string): void {
  if (!socket.destroyed) socket.write(`${line}\r\n`);
}

function resetTransaction(session: SmtpSession): void {
  session.mailFrom = false;
  session.recipients = [];
  session.dataMode = false;
  session.dataChunks = [];
  session.dataBytes = 0;
}

function closeWithReply(socket: TLSSocket, line: string): void {
  if (socket.destroyed) return;
  socket.end(`${line}\r\n`);
}

function consumeDataLine(
  socket: TLSSocket,
  session: SmtpSession,
  receiver: TestSmtpReceiver,
  line: Buffer,
): void {
  if (line.length === 1 && line[0] === 0x2e) {
    if (receiver.rejectDelivery) {
      reply(socket, "550 5.7.1 Delivery rejected by test receiver");
    } else if (receiver.messages.length >= MAX_MESSAGES) {
      reply(socket, "452 4.5.3 Test receiver message limit reached");
    } else {
      receiver.messages.push({
        recipients: [...session.recipients],
        raw: Buffer.concat(session.dataChunks, session.dataBytes).toString("utf8"),
      });
      reply(socket, "250 2.0.0 Message accepted for delivery");
    }
    resetTransaction(session);
    return;
  }

  const unstuffed = line.length >= 2 && line[0] === 0x2e && line[1] === 0x2e
    ? line.subarray(1)
    : line;
  const appendedBytes = unstuffed.length + 2;
  if (session.dataBytes + appendedBytes > MAX_MESSAGE_BYTES) {
    closeWithReply(socket, "552 5.3.4 Message exceeds fixed maximum size");
    return;
  }
  session.dataChunks.push(unstuffed, Buffer.from("\r\n"));
  session.dataBytes += appendedBytes;
}

function consumeCommandLine(socket: TLSSocket, session: SmtpSession, line: string): void {
  if (/^EHLO\s+\S+/i.test(line)) {
    session.greeted = true;
    resetTransaction(session);
    reply(socket, `250-${HOST}`);
    reply(socket, `250 SIZE ${MAX_MESSAGE_BYTES}`);
    return;
  }
  if (/^HELO\s+\S+/i.test(line)) {
    session.greeted = true;
    resetTransaction(session);
    reply(socket, `250 ${HOST}`);
    return;
  }
  if (/^RSET$/i.test(line)) {
    resetTransaction(session);
    reply(socket, "250 2.0.0 Reset state");
    return;
  }
  if (/^NOOP(?:\s.*)?$/i.test(line)) {
    reply(socket, "250 2.0.0 OK");
    return;
  }
  if (/^QUIT$/i.test(line)) {
    closeWithReply(socket, "221 2.0.0 Bye");
    return;
  }

  const mail = /^MAIL FROM:\s*<([^>]*)>(?:\s+.*)?$/i.exec(line);
  if (mail) {
    if (!session.greeted) {
      reply(socket, "503 5.5.1 Send EHLO or HELO first");
      return;
    }
    resetTransaction(session);
    session.mailFrom = true;
    reply(socket, "250 2.1.0 Sender accepted");
    return;
  }

  const recipient = /^RCPT TO:\s*<([^>]+)>(?:\s+.*)?$/i.exec(line);
  if (recipient) {
    if (!session.mailFrom) {
      reply(socket, "503 5.5.1 Send MAIL FROM first");
      return;
    }
    if (session.recipients.length >= MAX_RECIPIENTS) {
      reply(socket, "452 4.5.3 Too many recipients");
      return;
    }
    session.recipients.push(recipient[1]!.trim());
    reply(socket, "250 2.1.5 Recipient accepted");
    return;
  }

  if (/^DATA$/i.test(line)) {
    if (!session.mailFrom || session.recipients.length === 0) {
      reply(socket, "503 5.5.1 MAIL FROM and RCPT TO are required");
      return;
    }
    session.dataMode = true;
    session.dataChunks = [];
    session.dataBytes = 0;
    reply(socket, "354 End data with <CRLF>.<CRLF>");
    return;
  }

  reply(socket, "502 5.5.1 Command not implemented");
}

function handleSocket(socket: TLSSocket, receiver: TestSmtpReceiver): void {
  const session: SmtpSession = {
    greeted: false,
    mailFrom: false,
    recipients: [],
    dataMode: false,
    dataChunks: [],
    dataBytes: 0,
    pending: Buffer.alloc(0),
  };

  socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
    closeWithReply(socket, "421 4.4.2 Test receiver connection timed out");
  });
  socket.on("error", () => undefined);
  reply(socket, `220 ${HOST} test SMTP receiver ready`);

  socket.on("data", (chunk: Buffer) => {
    if (socket.destroyed) return;
    session.pending = Buffer.concat([session.pending, chunk]);
    while (!socket.destroyed) {
      const delimiter = session.pending.indexOf("\r\n");
      if (delimiter === -1) {
        if (session.pending.length > MAX_LINE_BYTES) {
          closeWithReply(socket, "500 5.2.3 SMTP line exceeds fixed maximum length");
        }
        return;
      }
      const line = session.pending.subarray(0, delimiter);
      session.pending = session.pending.subarray(delimiter + 2);
      if (line.length > MAX_LINE_BYTES) {
        closeWithReply(socket, "500 5.2.3 SMTP line exceeds fixed maximum length");
        return;
      }
      if (session.dataMode) {
        consumeDataLine(socket, session, receiver, line);
      } else {
        consumeCommandLine(socket, session, line.toString("utf8"));
      }
    }
  });
}

export async function startTestSmtp(input: {
  key: string | Buffer;
  cert: string | Buffer;
}): Promise<TestSmtpReceiver> {
  const sockets = new Set<Socket>();
  let closePromise: Promise<void> | null = null;
  const receiver: TestSmtpReceiver = {
    port: 0,
    messages: [],
    rejectDelivery: false,
    close() {
      closePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
          } else {
            resolve();
          }
        });
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };

  const server: Server = createServer(
    {
      key: input.key,
      cert: input.cert,
      handshakeTimeout: SOCKET_TIMEOUT_MS,
      requestCert: false,
      rejectUnauthorized: false,
    },
    (socket) => {
      handleSocket(socket, receiver);
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.on("connection", (socket) => {
    if (sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: HOST, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", () => undefined);

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Test SMTP receiver did not bind a TCP port.");
  }

  receiver.port = address.port;
  return receiver;
}
