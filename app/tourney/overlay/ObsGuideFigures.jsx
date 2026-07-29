// Annotated OBS interface mockups for the overlay setup guide. Hand-drawn
// SVG so the guide never hotlinks stock screenshots and the arrows always
// point at exactly the right control.

const PANEL = "#262b31";
const PANEL_DARK = "#1d2126";
const BORDER = "#3a4149";
const ROW = "#2e343b";
const TEXT = "#d6d9dd";
const MUTED = "#9aa1a9";
const ACCENT = "#fbbf24";
const HIGHLIGHT = "var(--ov-figure-highlight, rgba(34, 211, 238, 0.16))";
const URL_TEXT = "var(--ov-figure-url, #a5f3fc)";

const Arrow = ({ from, to, label, labelX, labelY }) => (
  <g>
    <path
      d={`M ${from[0]} ${from[1]} Q ${(from[0] + to[0]) / 2} ${from[1] - 26} ${to[0]} ${to[1]}`}
      fill="none"
      stroke={ACCENT}
      strokeWidth="2.5"
      markerEnd="url(#ov-arrow-head)"
    />
    {label ? (
      <text x={labelX} y={labelY} fill={ACCENT} fontSize="11.5" fontWeight="700">
        {label}
      </text>
    ) : null}
  </g>
);

const ArrowDefs = () => (
  <defs>
    <marker
      id="ov-arrow-head"
      markerWidth="8"
      markerHeight="8"
      refX="6"
      refY="3"
      orient="auto"
    >
      <path d="M0,0 L6,3 L0,6 Z" fill={ACCENT} />
    </marker>
  </defs>
);

// Step 1: the Sources dock with the + menu open and Browser highlighted.
export const ObsFigureAddSource = () => (
  <svg viewBox="0 0 480 330" role="img" aria-label="OBS Sources dock with the plus menu open and Browser highlighted">
    <ArrowDefs />
    <rect x="8" y="10" width="210" height="312" rx="7" fill={PANEL} stroke={BORDER} />
    <text x="22" y="34" fill={TEXT} fontSize="13" fontWeight="700">Sources</text>
    {["Gameplay", "Webcam", "Chat"].map((name, i) => (
      <g key={name}>
        <rect x="20" y={46 + i * 30} width="186" height="26" rx="4" fill={ROW} />
        <text x="30" y={63 + i * 30} fill={MUTED} fontSize="11.5">{name}</text>
      </g>
    ))}
    {/* bottom toolbar with the + button */}
    <rect x="14" y="288" width="198" height="28" rx="5" fill={PANEL_DARK} stroke={BORDER} />
    <circle cx="32" cy="302" r="9" fill={ROW} stroke={ACCENT} strokeWidth="2.5" />
    <text x="28.5" y="306" fill={TEXT} fontSize="12" fontWeight="700">+</text>
    <text x="50" y="306" fill={MUTED} fontSize="10.5">–    ⚙    ⬆    ⬇</text>
    {/* context menu */}
    <rect x="44" y="86" width="180" height="192" rx="6" fill={PANEL_DARK} stroke={BORDER} />
    {[
      "Audio Input Capture",
      "Audio Output Capture",
      "Browser",
      "Color Source",
      "Display Capture",
      "Game Capture",
      "Image",
    ].map((item, i) => {
      const y = 96 + i * 26;
      const isBrowser = item === "Browser";
      return (
        <g key={item}>
          {isBrowser ? (
            <rect x="48" y={y - 3} width="172" height="24" rx="4" fill={HIGHLIGHT} stroke={ACCENT} strokeWidth="1.5" />
          ) : null}
          <text x="58" y={y + 13} fill={isBrowser ? TEXT : MUTED} fontSize="11.5" fontWeight={isBrowser ? "700" : "400"}>
            {item}
          </text>
        </g>
      );
    })}
    <Arrow from={[252, 152]} to={[222, 152]} label="1. + → Browser" labelX={252} labelY={140} />
  </svg>
);

// Step 2: the small "Create/Select Source" name dialog.
export const ObsFigureNameSource = () => (
  <svg viewBox="0 0 480 330" role="img" aria-label="OBS create source dialog with a name typed in">
    <ArrowDefs />
    <rect x="60" y="86" width="360" height="158" rx="8" fill={PANEL} stroke={BORDER} />
    <rect x="60" y="86" width="360" height="30" rx="8" fill={PANEL_DARK} stroke={BORDER} />
    <text x="76" y="106" fill={TEXT} fontSize="12.5" fontWeight="700">Create/Select Source</text>
    <rect x="78" y="128" width="324" height="52" rx="5" fill={PANEL_DARK} stroke={BORDER} />
    <circle cx="92" cy="146" r="4" fill={TEXT} />
    <text x="104" y="150" fill={MUTED} fontSize="11">Create new</text>
    <rect x="86" y="156" width="300" height="18" rx="3" fill="#14171b" stroke="#0e7490" strokeWidth="1.5" />
    <text x="92" y="169" fill={TEXT} fontSize="11">Live bracket</text>
    <rect x="262" y="196" width="66" height="26" rx="5" fill="#0e7490" stroke={ACCENT} strokeWidth="2" />
    <text x="284" y="213" fill="#fff" fontSize="11.5" fontWeight="700">OK</text>
    <rect x="336" y="196" width="66" height="26" rx="5" fill={ROW} stroke={BORDER} />
    <text x="355" y="213" fill={TEXT} fontSize="11.5">Cancel</text>
    <Arrow from={[140, 210]} to={[130, 178]} label="2. name it, hit OK" labelX={70} labelY={236} />
  </svg>
);

// Step 3: the Browser source properties dialog.
export const ObsFigureProperties = () => (
  <svg viewBox="0 0 480 330" role="img" aria-label="OBS browser source properties with URL, width and height highlighted">
    <ArrowDefs />
    <rect x="60" y="14" width="360" height="302" rx="8" fill={PANEL} stroke={BORDER} />
    <rect x="60" y="14" width="360" height="30" rx="8" fill={PANEL_DARK} stroke={BORDER} />
    <text x="76" y="34" fill={TEXT} fontSize="12.5" fontWeight="700">Properties for 'Live bracket'</text>
    <text x="78" y="66" fill={MUTED} fontSize="11">URL</text>
    <rect x="76" y="72" width="328" height="22" rx="4" fill="#14171b" stroke={ACCENT} strokeWidth="2" />
    <text x="84" y="87" fill={URL_TEXT} fontSize="10.5">https://www.rooindustries.com/tourney/overlay/br…</text>
    <text x="78" y="122" fill={MUTED} fontSize="11">Width</text>
    <text x="200" y="122" fill={MUTED} fontSize="11">Height</text>
    <rect x="76" y="128" width="100" height="22" rx="4" fill="#14171b" stroke={ACCENT} strokeWidth="2" />
    <text x="86" y="143" fill={TEXT} fontSize="11">1920</text>
    <rect x="198" y="128" width="100" height="22" rx="4" fill="#14171b" stroke={ACCENT} strokeWidth="2" />
    <text x="208" y="143" fill={TEXT} fontSize="11">1080</text>
    <text x="78" y="180" fill={MUTED} fontSize="11">FPS</text>
    <rect x="76" y="186" width="100" height="22" rx="4" fill="#14171b" stroke={BORDER} />
    <text x="86" y="201" fill={MUTED} fontSize="11">30</text>
    <rect x="78" y="222" width="12" height="12" rx="2" fill="#14171b" stroke={BORDER} />
    <text x="98" y="232" fill={MUTED} fontSize="10.5">Refresh browser when scene becomes active</text>
    <text x="98" y="248" fill={ACCENT} fontSize="10.5" fontWeight="700">leave this unticked</text>
    <rect x="262" y="278" width="66" height="26" rx="5" fill="#0e7490" stroke={ACCENT} strokeWidth="2" />
    <text x="284" y="295" fill="#fff" fontSize="11.5" fontWeight="700">OK</text>
    <rect x="336" y="278" width="66" height="26" rx="5" fill={ROW} stroke={BORDER} />
    <text x="355" y="295" fill={TEXT} fontSize="11.5">Cancel</text>
    <Arrow from={[14, 84]} to={[72, 84]} label="3. paste URL" labelX={2} labelY={72} />
    <Arrow from={[14, 140]} to={[72, 140]} label="4. size" labelX={4} labelY={128} />
  </svg>
);
