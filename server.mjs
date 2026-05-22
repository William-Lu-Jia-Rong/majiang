import express from "express";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4173);
const dataDir = path.join(__dirname, "data");
const tableFile = path.join(dataDir, "table.json");
const distDir = path.join(__dirname, "dist");

function isTableState(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      Array.isArray(value.players) &&
      value.players.length >= 2 &&
      value.scores &&
      typeof value.scores === "object" &&
      Array.isArray(value.ledger),
  );
}

async function loadTable() {
  try {
    const raw = await readFile(tableFile, "utf8");
    const parsed = JSON.parse(raw);
    return isTableState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function saveTable(table) {
  await mkdir(dataDir, { recursive: true });
  if (!table) {
    await writeFile(tableFile, "null\n", "utf8");
    return;
  }
  await writeFile(tableFile, `${JSON.stringify(table, null, 2)}\n`, "utf8");
}

function getLanUrls() {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        urls.push(`http://${address.address}:${PORT}`);
      }
    }
  }
  return urls;
}

let table = await loadTable();

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
  },
});

app.use(express.json({ limit: "1mb" }));

app.get("/api/table", (_request, response) => {
  response.json({ table });
});

app.get("/api/network", (_request, response) => {
  response.json({
    port: PORT,
    urls: getLanUrls(),
  });
});

app.use(express.static(distDir));

io.on("connection", (socket) => {
  socket.emit("table:init", table);

  socket.on("table:set", async (nextTable) => {
    if (!isTableState(nextTable)) return;
    table = {
      ...nextTable,
      updatedAt: new Date().toISOString(),
    };
    await saveTable(table);
    io.emit("table:update", table);
  });

  socket.on("table:clear", async () => {
    table = null;
    await saveTable(table);
    io.emit("table:clear");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  const urls = getLanUrls();
  console.log(`雀账台局域网服务器已启动`);
  console.log(`本机: http://localhost:${PORT}`);
  if (urls.length > 0) {
    console.log("同一 Wi-Fi 下可用:");
    urls.forEach((url) => console.log(`  ${url}`));
  }
});
