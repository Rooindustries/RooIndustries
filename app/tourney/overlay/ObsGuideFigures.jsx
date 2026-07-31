// Annotated OBS interface mockups for the overlay setup guide. Hand-drawn
// SVG so the guide never hotlinks stock screenshots and the arrows always
// point at exactly the right control. Drawn against the real OBS 32.2.1
// macOS dialogs (verified on-screen); every step label sits outside the
// dialog frames so labels and inputs can never collide.

const PANEL = "#262b31";
const PANEL_DARK = "#1d2126";
const BORDER = "#3a4149";
const ROW = "#2e343b";
const FIELD = "#14171b";
const TEXT = "#d6d9dd";
const MUTED = "#9aa1a9";
const DIM = "#6b7280";
const ACCENT = "#fbbf24";
const HIGHLIGHT = "var(--ov-figure-highlight, rgba(34, 211, 238, 0.16))";
const URL_TEXT = "var(--ov-figure-url, #a5f3fc)";

const Arrow = ({ from, to, label, labelX, labelY, anchor = "start", labelSize = 11.5 }) => (
  <g>
    <line
      x1={from[0]}
      y1={from[1]}
      x2={to[0]}
      y2={to[1]}
      stroke={ACCENT}
      strokeWidth="2.5"
      markerEnd="url(#ov-arrow-head)"
    />
    {label ? (
      <text
        x={labelX}
        y={labelY}
        fill={ACCENT}
        fontSize={labelSize}
        fontWeight="700"
        textAnchor={anchor}
      >
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

// Step 1: the Sources dock with the + menu open and Add Source highlighted.
export const ObsFigureAddSource = () => (
  <svg viewBox="0 0 480 300" role="img" aria-label="OBS Sources dock with the plus menu open and Add Source highlighted">
    <ArrowDefs />
    <rect x="16" y="10" width="192" height="278" rx="7" fill={PANEL} stroke={BORDER} />
    <text x="30" y="32" fill={TEXT} fontSize="13" fontWeight="700">Sources</text>
    {["Gameplay", "Webcam", "Chat"].map((name, i) => (
      <g key={name}>
        <rect x="28" y={44 + i * 30} width="168" height="26" rx="4" fill={ROW} />
        <text x="38" y={61 + i * 30} fill={MUTED} fontSize="11.5">{name}</text>
      </g>
    ))}
    {/* bottom toolbar: +, remove, properties, move up, move down */}
    <rect x="22" y="252" width="180" height="28" rx="5" fill={PANEL_DARK} stroke={BORDER} />
    <circle cx="40" cy="266" r="9" fill={ROW} stroke={ACCENT} strokeWidth="2.5" />
    <text x="36.5" y="270" fill={TEXT} fontSize="12" fontWeight="700">+</text>
    <rect x="58" y="259" width="14" height="14" rx="3" fill="none" stroke={MUTED} strokeWidth="1.4" />
    <line x1="61.5" y1="266" x2="68.5" y2="266" stroke={MUTED} strokeWidth="1.6" />
    <text x="84" y="270" fill={MUTED} fontSize="12">⚙</text>
    <polyline points="108,269 113,262 118,269" fill="none" stroke={MUTED} strokeWidth="1.8" />
    <polyline points="132,263 137,270 142,263" fill="none" stroke={MUTED} strokeWidth="1.8" />
    {/* the + menu: Add Source is the top entry in OBS 32.2 */}
    <rect x="34" y="94" width="176" height="148" rx="6" fill={PANEL_DARK} stroke={BORDER} />
    <rect x="38" y="98" width="168" height="26" rx="4" fill={HIGHLIGHT} stroke={ACCENT} strokeWidth="1.5" />
    <text x="50" y="115" fill={TEXT} fontSize="11.5" fontWeight="700">Add Source</text>
    <text x="50" y="141" fill={MUTED} fontSize="11.5">New Group</text>
    <line x1="42" y1="158" x2="202" y2="158" stroke={BORDER} strokeWidth="1" />
    <text x="50" y="176" fill={MUTED} fontSize="11">Paste (Reference)</text>
    <text x="198" y="176" fill={DIM} fontSize="9.5" textAnchor="end">Ctrl+V</text>
    <text x="50" y="202" fill={DIM} fontSize="11">Paste (Duplicate)</text>
    <Arrow from={[262, 128]} to={[212, 112]} label="1. + → Add Source" labelX={262} labelY={116} />
  </svg>
);

// Step 2: the OBS 32.2 Add Source dialog — pick Browser in the type list,
// then the dashed "+ Add a new Browser" button. There is no name field in
// 32.2; the source is created with a default name and renamed afterwards.
// Sidebar order matches the real macOS dialog.
export const ObsFigureNameSource = () => (
  <svg viewBox="0 0 480 330" role="img" aria-label="OBS Add Source dialog with Browser selected and the Add a new Browser button highlighted">
    <ArrowDefs />
    <rect x="8" y="8" width="464" height="300" rx="8" fill={PANEL} stroke={BORDER} />
    <rect x="8" y="8" width="464" height="26" rx="8" fill={PANEL_DARK} stroke={BORDER} />
    <text x="22" y="26" fill={TEXT} fontSize="12.5" fontWeight="700">Add Source</text>
    <text x="452" y="26" fill={MUTED} fontSize="11" textAnchor="end">✕</text>
    {[
      "Recently Created",
      "Audio Input Capture",
      "Browser",
      "Capture Card Device",
      "Color",
      "Image",
      "Image Slide Show",
      "macOS Audio Capture",
      "macOS Screen Capture",
      "Media",
      "…",
    ].map((item, i) => {
      const y = 46 + i * 19;
      const isBrowser = item === "Browser";
      return (
        <g key={item}>
          {isBrowser ? (
            <rect x="14" y={y - 13} width="128" height="21" rx="4" fill={HIGHLIGHT} stroke={ACCENT} strokeWidth="1.5" />
          ) : null}
          <text x="22" y={y + 2} fill={isBrowser ? TEXT : MUTED} fontSize="9.5" fontWeight={isBrowser ? "700" : "400"}>
            {item}
          </text>
        </g>
      );
    })}
    <text x="158" y="54" fill={TEXT} fontSize="13" fontWeight="700">Browser</text>
    <text x="158" y="69" fill={MUTED} fontSize="8.5">Select which source(s) to add to your current scene.</text>
    <rect x="152" y="82" width="312" height="32" rx="6" fill={HIGHLIGHT} stroke={ACCENT} strokeWidth="2" strokeDasharray="5 4" />
    <circle cx="250" cy="98" r="6.5" fill="none" stroke={ACCENT} strokeWidth="1.8" />
    <line x1="246.5" y1="98" x2="253.5" y2="98" stroke={ACCENT} strokeWidth="1.8" />
    <line x1="250" y1="94.5" x2="250" y2="101.5" stroke={ACCENT} strokeWidth="1.8" />
    <text x="262" y="102" fill={ACCENT} fontSize="11.5" fontWeight="700">Add a new Browser</text>
    <text x="308" y="172" fill={MUTED} fontSize="9" textAnchor="middle">You have no existing Browser sources yet.</text>
    <rect x="152" y="228" width="100" height="22" rx="5" fill={ROW} stroke={BORDER} />
    <text x="202" y="242" fill={DIM} fontSize="10" textAnchor="middle">Add existing</text>
    <rect x="18" y="274" width="11" height="11" rx="2" fill={ROW} stroke={BORDER} />
    <text x="21.5" y="283" fill={MUTED} fontSize="9">✓</text>
    <text x="36" y="284" fill={MUTED} fontSize="9.5">Make source visible</text>
    <rect x="398" y="268" width="64" height="22" rx="5" fill={ROW} stroke={BORDER} />
    <text x="430" y="282" fill={MUTED} fontSize="10" textAnchor="middle">Close</text>
    <Arrow
      from={[308, 322]}
      to={[308, 120]}
      label="2. pick Browser, then + Add a new Browser"
      labelX={308}
      labelY={326}
      anchor="middle"
    />
  </svg>
);

// Steps 3–5: the Browser source properties dialog. The full field inventory
// of the real 32.2.1 macOS dialog, including the one-time welcome banner
// first-time users see. Only URL, Width and Height need values; step labels
// sit in the left gutter, outside the frame.
export const ObsFigureProperties = () => (
  <svg viewBox="0 0 480 500" role="img" aria-label="OBS browser source properties with URL, width and height highlighted">
    <ArrowDefs />
    <rect x="110" y="8" width="362" height="484" rx="8" fill={PANEL} stroke={BORDER} />
    <rect x="110" y="8" width="362" height="26" rx="8" fill={PANEL_DARK} stroke={BORDER} />
    <text x="124" y="26" fill={TEXT} fontSize="12" fontWeight="700">Properties for &apos;Browser&apos;</text>
    {/* one-time welcome banner shown the first time a browser source is added */}
    <rect x="126" y="40" width="330" height="76" rx="5" fill="#1e2a52" stroke={BORDER} />
    <circle cx="152" cy="70" r="13" fill="none" stroke="#e5e7eb" strokeWidth="2.5" />
    <path d="M152 60 a10 10 0 0 1 9 13 M145 79 a10 10 0 0 1 -2 -14 M159 76 a10 10 0 0 1 -12 -3" fill="none" stroke="#e5e7eb" strokeWidth="2" />
    <text x="176" y="62" fill={TEXT} fontSize="9.5" fontWeight="700">You&apos;ve just added a browser source!</text>
    <text x="176" y="76" fill={MUTED} fontSize="8">Browser sources display a webpage and are</text>
    <text x="176" y="87" fill={MUTED} fontSize="8">commonly used for widgets and alerts.</text>
    <text x="176" y="103" fill={MUTED} fontSize="8" fontStyle="italic">Set the URL to the page you&apos;d like to display.</text>
    {/* fields, in the real dialog order */}
    <rect x="124" y="128" width="11" height="11" rx="2" fill={FIELD} stroke={BORDER} />
    <text x="142" y="137" fill={MUTED} fontSize="9.5">Local file</text>
    <text x="124" y="158" fill={MUTED} fontSize="10">URL</text>
    <rect x="122" y="164" width="338" height="22" rx="4" fill={FIELD} stroke={ACCENT} strokeWidth="2" />
    <text x="130" y="179" fill={URL_TEXT} fontSize="10">https://www.rooindustries.com/tourney/overlay/br…</text>
    <text x="124" y="206" fill={MUTED} fontSize="10">Width</text>
    <rect x="122" y="212" width="338" height="22" rx="4" fill={FIELD} stroke={ACCENT} strokeWidth="2" />
    <text x="130" y="227" fill={TEXT} fontSize="10.5">1920</text>
    <polyline points="448,218 452,214 456,218" fill="none" stroke={DIM} strokeWidth="1.4" />
    <polyline points="448,228 452,232 456,228" fill="none" stroke={DIM} strokeWidth="1.4" />
    <text x="124" y="254" fill={MUTED} fontSize="10">Height</text>
    <rect x="122" y="260" width="338" height="22" rx="4" fill={FIELD} stroke={ACCENT} strokeWidth="2" />
    <text x="130" y="275" fill={TEXT} fontSize="10.5">1080</text>
    <polyline points="448,266 452,262 456,266" fill="none" stroke={DIM} strokeWidth="1.4" />
    <polyline points="448,276 452,280 456,276" fill="none" stroke={DIM} strokeWidth="1.4" />
    <rect x="124" y="292" width="11" height="11" rx="2" fill={FIELD} stroke={BORDER} />
    <text x="142" y="301" fill={MUTED} fontSize="9.5">Control audio via OBS</text>
    <rect x="124" y="308" width="11" height="11" rx="2" fill={FIELD} stroke={BORDER} />
    <text x="142" y="317" fill={MUTED} fontSize="9.5">Use custom frame rate</text>
    <text x="124" y="340" fill={MUTED} fontSize="10">Custom CSS</text>
    <rect x="122" y="346" width="338" height="30" rx="4" fill={FIELD} stroke={BORDER} />
    <text x="128" y="360" fill={DIM} fontSize="8">body {"{"} background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; {"}"}</text>
    <rect x="124" y="386" width="11" height="11" rx="2" fill={FIELD} stroke={BORDER} />
    <text x="142" y="395" fill={MUTED} fontSize="9.5">Shutdown source when not visible</text>
    <rect x="124" y="402" width="11" height="11" rx="2" fill={FIELD} stroke={BORDER} />
    <text x="142" y="411" fill={MUTED} fontSize="9.5">Refresh browser when scene becomes active</text>
    <text x="124" y="434" fill={MUTED} fontSize="10">Page permissions</text>
    <rect x="212" y="424" width="248" height="18" rx="4" fill={FIELD} stroke={BORDER} />
    <text x="220" y="437" fill={MUTED} fontSize="8.5">Read access to OBS status information</text>
    <text x="450" y="437" fill={DIM} fontSize="8">▾</text>
    <rect x="122" y="448" width="140" height="18" rx="4" fill={ROW} stroke={BORDER} />
    <text x="192" y="461" fill={MUTED} fontSize="9" textAnchor="middle">Refresh cache of current page</text>
    {/* bottom bar */}
    <rect x="122" y="472" width="0" height="0" />
    <rect x="124" y="470" width="70" height="20" rx="5" fill={ROW} stroke={BORDER} />
    <text x="159" y="484" fill={MUTED} fontSize="10" textAnchor="middle">Defaults</text>
    <rect x="318" y="470" width="66" height="20" rx="5" fill={ROW} stroke={BORDER} />
    <text x="351" y="484" fill={TEXT} fontSize="10" textAnchor="middle">Cancel</text>
    <rect x="392" y="470" width="66" height="20" rx="5" fill="#0e7490" stroke={ACCENT} strokeWidth="2" />
    <text x="425" y="484" fill="#fff" fontSize="10.5" fontWeight="700" textAnchor="middle">OK</text>
    <Arrow from={[104, 175]} to={[120, 175]} label="3. paste URL" labelX={100} labelY={175} anchor="end" labelSize={10.5} />
    <Arrow from={[104, 247]} to={[120, 247]} label="4. set the size" labelX={100} labelY={247} anchor="end" labelSize={10.5} />
    <Arrow from={[104, 480]} to={[120, 480]} label="5. defaults → OK" labelX={100} labelY={480} anchor="end" labelSize={10.5} />
  </svg>
);
