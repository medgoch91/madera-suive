// Minimal Deno FTP client for Edge Functions.
//
// Just enough protocol to do an authenticated PASV-mode binary STOR — used
// for daily off-site backups to Hostinger. No SDK dependency: opens a TCP
// control connection via Deno.connect, sends the standard command sequence,
// opens the data connection on the address the server returned in 227, and
// streams the bytes through.
//
// Limitations:
//   - PASV (IPv4) only, no EPSV/IPv6
//   - Plaintext FTP only (no FTPS); Hostinger control plane is plain FTP/21
//   - Single-shot upload — no LIST / DELE / re-use
//
// Used by jobBackupFtp() in jobs.ts.

const TE = new TextEncoder();
const TD = new TextDecoder();

// Read until we see a complete final-line FTP response (a line starting with
// "<3-digit code> " — note the SPACE, not "-"; "-" marks continuation lines).
async function readReply(conn: Deno.Conn): Promise<{ code: number; text: string }> {
  let buf = '';
  const chunk = new Uint8Array(2048);
  while (true) {
    const n = await conn.read(chunk);
    if (n === null) throw new Error('FTP: unexpected EOF, partial buffer: ' + JSON.stringify(buf));
    buf += TD.decode(chunk.subarray(0, n));
    // Multi-line replies: "123-..." then continuation lines, terminated by "123 ..."
    const lines = buf.split('\r\n');
    for (const line of lines) {
      const m = line.match(/^(\d{3}) (.*)$/);
      if (m) return { code: Number(m[1]), text: buf };
    }
    // No final-line yet, keep reading
  }
}

async function sendCmd(conn: Deno.Conn, cmd: string, expect: number[]): Promise<{ code: number; text: string }> {
  await conn.write(TE.encode(cmd + '\r\n'));
  const reply = await readReply(conn);
  if (!expect.includes(reply.code)) {
    throw new Error('FTP cmd "' + cmd.split(' ')[0] + '" expected ' + expect.join('/') + ', got ' + reply.code + ': ' + reply.text.trim());
  }
  return reply;
}

export interface FtpUploadOpts {
  host: string;
  port?: number;
  user: string;
  pass: string;
  remotePath: string;       // e.g. "backups/backup-YYYY-MM-DD.json"
  content: string | Uint8Array;
}

export async function ftpUpload(opts: FtpUploadOpts): Promise<void> {
  const port = opts.port ?? 21;
  const ctrl = await Deno.connect({ hostname: opts.host, port });
  let dataConn: Deno.Conn | null = null;
  try {
    // Welcome banner
    const welcome = await readReply(ctrl);
    if (welcome.code !== 220) throw new Error('FTP: bad banner ' + welcome.code + ': ' + welcome.text.trim());

    await sendCmd(ctrl, 'USER ' + opts.user, [331, 230]);
    await sendCmd(ctrl, 'PASS ' + opts.pass, [230]);
    await sendCmd(ctrl, 'TYPE I', [200]);

    // Best-effort mkdir for each path segment (550 already-exists is fine)
    const segments = opts.remotePath.split('/').slice(0, -1).filter(Boolean);
    let cur = '';
    for (const seg of segments) {
      cur = cur ? cur + '/' + seg : seg;
      try { await sendCmd(ctrl, 'MKD ' + cur, [257, 550]); } catch (_) { /* ignore */ }
    }

    // PASV
    const pasv = await sendCmd(ctrl, 'PASV', [227]);
    const m = pasv.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if (!m) throw new Error('FTP: malformed PASV reply: ' + pasv.text.trim());
    const dataHost = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
    const dataPort = (Number(m[5]) << 8) + Number(m[6]);
    dataConn = await Deno.connect({ hostname: dataHost, port: dataPort });

    // STOR — server replies 150 once it's ready to accept on the data conn
    await sendCmd(ctrl, 'STOR ' + opts.remotePath, [150, 125]);

    // Stream bytes through the data connection
    const bytes = typeof opts.content === 'string' ? TE.encode(opts.content) : opts.content;
    let off = 0;
    while (off < bytes.length) {
      const w = await dataConn.write(bytes.subarray(off, Math.min(off + 16384, bytes.length)));
      off += w;
    }
    // Close data connection — server replies 226 on control once it sees EOF
    try { dataConn.close(); } catch (_) {}
    dataConn = null;
    const done = await readReply(ctrl);
    if (done.code !== 226 && done.code !== 250) {
      throw new Error('FTP: STOR final reply ' + done.code + ': ' + done.text.trim());
    }
  } finally {
    if (dataConn) { try { dataConn.close(); } catch (_) {} }
    try { await sendCmd(ctrl, 'QUIT', [221]); } catch (_) {}
    try { ctrl.close(); } catch (_) {}
  }
}
