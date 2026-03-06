const fs = require("fs");
const path = require("path");

// --- RAM ELIGIBILITY ---
// Minimum speed 6000
// 6000 MT/s -> CL <= 32
// 6200 MT/s -> CL <= 34
// 6400 MT/s -> CL <= 36
// 6600+ MT/s -> no CL limit
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

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", ["GET"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const base = process.cwd();
    const mobosDir = path.join(base, "xoc-data", "motherboards");
    const ramsDir = path.join(base, "xoc-data", "rams");

    const mobosRaw = loadJsonDir(mobosDir);
    const ramsRaw = loadJsonDir(ramsDir);

    // Motherboards:
    // We only show the ones that are clearly compatible:
    //  - socket: AM5
    //  - memory.ram_type: DDR5
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

    return res.status(200).json({
      ok: true,
      source: "buildcores-open-db-local",
      motherboards,
      rams,
    });
  } catch (err) {
    console.error("Error in /api/xocParts:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Internal server error loading XOC parts" });
  }
};
