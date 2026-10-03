import { Bot, InlineKeyboard, InputFile } from "grammy";
import archiver from "archiver";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("Set BOT_TOKEN in the environment");

const bot = new Bot(TOKEN);

// Telegram Bot API limits (cloud API)
const MAX_DOWNLOAD = 20 * 1024 * 1024; // bot can download files up to 20 MB
const MAX_UPLOAD = 50 * 1024 * 1024; // bot can upload files up to 50 MB
const MAX_FILES = 100;
const SESSION_TTL_MS = 60 * 60 * 1000; // forget collected files after 1 hour

/** @type {Map<number, {files: Array, updatedAt: number, zipName: string, busy: boolean}>} */
const sessions = new Map();

function getSession(userId) {
  let s = sessions.get(userId);
  if (!s) {
    s = { files: [], updatedAt: Date.now(), zipName: "files", busy: false };
    sessions.set(userId, s);
  }
  s.updatedAt = Date.now();
  return s;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (!s.busy && now - s.updatedAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000).unref();

const fmtSize = (b) =>
  b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

const safeName = (n) => n.replace(/[\\/:*?"<>|]+/g, "_").trim() || "file";

function uniqueName(name, taken) {
  if (!taken.has(name)) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let i = 2;
  while (taken.has(`${base} (${i})${ext}`)) i++;
  return `${base} (${i})${ext}`;
}

function keyboard(count) {
  return new InlineKeyboard()
    .text(`📦 Zip ${count} file${count === 1 ? "" : "s"}`, "zip")
    .text("🗑 Clear", "clear");
}

// ---------- commands ----------
bot.command("start", (ctx) =>
  ctx.reply(
    "👋 Send me your files (documents, photos, videos, audio, voice notes) and I'll pack them into a single ZIP.\n\n" +
      "• Send as many files as you like\n" +
      "• Tap 📦 Zip, or use /zip [name]\n" +
      "• /list – show collected files\n" +
      "• /clear – start over\n\n" +
      "Tip: send photos as *File* (not compressed photo) to keep original quality.\n" +
      "Limit: 20 MB per file, 50 MB total ZIP.",
    { parse_mode: "Markdown" }
  )
);

bot.command("help", (ctx) => ctx.reply("Send files, then /zip [optional name]. /list and /clear also available."));

bot.command("list", async (ctx) => {
  const s = getSession(ctx.from.id);
  if (!s.files.length) return ctx.reply("No files yet. Send me some!");
  const lines = s.files.map((f, i) => `${i + 1}. ${f.name} (${fmtSize(f.size)})`);
  await ctx.reply(lines.join("\n"), { reply_markup: keyboard(s.files.length) });
});

bot.command("clear", (ctx) => {
  sessions.delete(ctx.from.id);
  return ctx.reply("🗑 Cleared. Send new files whenever you're ready.");
});

bot.command("zip", (ctx) => {
  const name = ctx.match?.trim();
  if (name) getSession(ctx.from.id).zipName = safeName(name).replace(/\.zip$/i, "");
  return makeZip(ctx);
});

bot.callbackQuery("zip", async (ctx) => {
  await ctx.answerCallbackQuery();
  return makeZip(ctx);
});

bot.callbackQuery("clear", async (ctx) => {
  sessions.delete(ctx.from.id);
  await ctx.answerCallbackQuery({ text: "Cleared" });
  await ctx.reply("🗑 Cleared.");
});

// ---------- collecting files ----------
bot.on(
  ["message:document", "message:photo", "message:video", "message:audio", "message:voice", "message:video_note", "message:animation"],
  async (ctx) => {
    const m = ctx.message;
    let file_id, name, size;

    if (m.document) {
      ({ file_id } = m.document);
      name = m.document.file_name || `document_${m.message_id}`;
      size = m.document.file_size ?? 0;
    } else if (m.photo) {
      const p = m.photo[m.photo.length - 1];
      file_id = p.file_id;
      name = `photo_${m.message_id}.jpg`;
      size = p.file_size ?? 0;
    } else if (m.video) {
      file_id = m.video.file_id;
      name = m.video.file_name || `video_${m.message_id}.mp4`;
      size = m.video.file_size ?? 0;
    } else if (m.audio) {
      file_id = m.audio.file_id;
      name = m.audio.file_name || `audio_${m.message_id}.mp3`;
      size = m.audio.file_size ?? 0;
    } else if (m.voice) {
      file_id = m.voice.file_id;
      name = `voice_${m.message_id}.ogg`;
      size = m.voice.file_size ?? 0;
    } else if (m.video_note) {
      file_id = m.video_note.file_id;
      name = `video_note_${m.message_id}.mp4`;
      size = m.video_note.file_size ?? 0;
    } else {
      file_id = m.animation.file_id;
      name = m.animation.file_name || `animation_${m.message_id}.mp4`;
      size = m.animation.file_size ?? 0;
    }

    if (size > MAX_DOWNLOAD)
      return ctx.reply(`⚠️ "${name}" is ${fmtSize(size)} – bots can only download files up to 20 MB. Skipped.`);

    const s = getSession(ctx.from.id);
    if (s.busy) return ctx.reply("⏳ Still zipping, please wait a moment.");
    if (s.files.length >= MAX_FILES) return ctx.reply(`⚠️ Max ${MAX_FILES} files per ZIP. Tap Zip or /clear.`);

    s.files.push({ file_id, name: safeName(name), size });
    await ctx.reply(`✅ Added: ${safeName(name)}\n${s.files.length} file${s.files.length === 1 ? "" : "s"} ready.`, {
      reply_markup: keyboard(s.files.length),
      reply_parameters: { message_id: m.message_id },
    });
  }
);

// ---------- zipping ----------
async function makeZip(ctx) {
  const userId = ctx.from.id;
  const s = getSession(userId);
  if (!s.files.length) return ctx.reply("No files to zip. Send me some first!");
  if (s.busy) return ctx.reply("⏳ Already working on it…");

  s.busy = true;
  const status = await ctx.reply(`⏳ Zipping ${s.files.length} file(s)…`);
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zipbot-"));
  const zipPath = path.join(tmpDir, `${s.zipName}.zip`);

  try {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    const done = new Promise((resolve, reject) => {
      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);
    });
    archive.pipe(output);

    const taken = new Set();
    for (const f of s.files) {
      const info = await ctx.api.getFile(f.file_id);
      const url = `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`;
      const res = await fetch(url);
      if (!res.ok || !res.body) throw new Error(`Download failed for ${f.name}`);
      const entryName = uniqueName(f.name, taken);
      taken.add(entryName);
      // write each file to disk first so memory stays flat
      const tmpFile = path.join(tmpDir, `${taken.size}.bin`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpFile));
      archive.file(tmpFile, { name: entryName });
    }

    await archive.finalize();
    await done;

    const { size } = await fs.promises.stat(zipPath);
    if (size > MAX_UPLOAD) {
      await ctx.reply(
        `⚠️ The ZIP is ${fmtSize(size)}, over Telegram's 50 MB bot upload limit. Use /clear and zip fewer files at a time.`
      );
      return;
    }

    await ctx.replyWithDocument(new InputFile(zipPath, `${s.zipName}.zip`), {
      caption: `📦 ${s.files.length} file(s) • ${fmtSize(size)}`,
    });
    sessions.delete(userId);
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Something went wrong while zipping. Your files are still saved – try /zip again.");
  } finally {
    const cur = sessions.get(userId);
    if (cur) cur.busy = false;
    ctx.api.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

bot.catch((err) => console.error("Bot error:", err.error));

bot.start({ onStart: (me) => console.log(`@${me.username} is running`) });
