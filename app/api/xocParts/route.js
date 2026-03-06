import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

function isXocRamEligible(speed, casLatency) {
  const s = Number(speed);
  const c = Number(casLatency);

  if (!s || !c) return false;
  if (s < 6000) return false;

  if (s === 6000) return c <= 32;
  if (s === 6200) return c <= 34;
  if (s === 6400) return c <= 36;
  if (s >= 6600) return true;

  return false;
}

function loadJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".json"));

  const items = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const raw = fs.readFileSync(full, "utf8");
      const parsed = JSON.parse(raw);
      items.push(parsed);
    } catch (err) {
      console.error("Failed to read/parse", full, err);
    }
  }
  return items;
}

export async function GET() {
  try {
    const base = process.cwd();
    const mobosDir = path.join(base, "xoc-data", "motherboards");
    const ramsDir = path.join(base, "xoc-data", "rams");

    const mobosRaw = loadJsonDir(mobosDir);
    const ramsRaw = loadJsonDir(ramsDir);

    const motherboards = mobosRaw
      .filter(
        (m) =>
          m && m.socket === "AM5" && m.memory && m.memory.ram_type === "DDR5"
      )
      .map((m) => ({
        id: m.opendb_id,
        name: m.metadata?.name || "Unknown motherboard",
        manufacturer: m.metadata?.manufacturer || "",
        partNumbers: m.metadata?.part_numbers || [],
        series: m.metadata?.series || "",
        socket: m.socket,
        ram_type: m.memory?.ram_type || "",
        maxMemoryGb: m.memory?.max ?? null,
        slots: m.memory?.slots ?? null,
        form_factor: m.form_factor || "",
        chipset: m.chipset || "",
      }));

    const rams = ramsRaw
      .filter((r) => r && r.ram_type === "DDR5")
      .filter((r) => isXocRamEligible(r.speed, r.cas_latency))
      .map((r) => ({
        id: r.opendb_id,
        name: r.metadata?.name || "Unknown RAM kit",
        manufacturer: r.metadata?.manufacturer || "",
        partNumbers: r.metadata?.part_numbers || [],
        series: r.metadata?.series || "",
        speed: r.speed,
        cas_latency: r.cas_latency,
        capacityGb: r.capacity,
        modules: r.modules || null,
      }));

    return Response.json(
      {
        ok: true,
        source: "buildcores-open-db-local",
        motherboards,
        rams,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Error in /api/xocParts:", err);
    return Response.json(
      { ok: false, error: "Internal server error loading XOC parts" },
      { status: 500 }
    );
  }
}

