import React, { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Html, RoundedBox } from "@react-three/drei";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

const smoothstep = (value, edge0, edge1) => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// Rises across [inStart, inEnd], holds at 1, falls back across [outStart, outEnd].
const pulse = (p, inStart, inEnd, outStart, outEnd) =>
  smoothstep(p, inStart, inEnd) * (1 - smoothstep(p, outStart, outEnd));

// The first stretch of the wrapper shows the hero copy over an idle GPU.
// The teardown story plays on the remapped scene progress after that.
export const heroPhase = (rawP) => 1 - smoothstep(rawP, 0.02, 0.2);
export const scenePhase = (rawP) => clamp01((rawP - 0.16) / 0.84);

// Five hero compositions sharing one scene graph. Selected via ?hero3d=vN.
export const HERO3D_VARIANTS = {
  v1: { loadScale: 0.85, loadY: -0.5, loadX: 0, loadRotY: 0, scrim: 1.0, envRamp: false, preExplode: 0 },
  v2: { loadScale: 0.8, loadY: -0.35, loadX: 1.5, loadRotY: 1.1, scrim: 0.75, envRamp: false, preExplode: 0 },
  v3: { loadScale: 1.08, loadY: -1.1, loadX: 0, loadRotY: 0, scrim: 0.45, envRamp: false, preExplode: 0 },
  v4: { loadScale: 0.9, loadY: -0.45, loadX: 0, loadRotY: 0, scrim: 0.3, envRamp: true, envFloor: 0.12, envCeil: 0.55, dark: true, preExplode: 0 },
  v5: { loadScale: 0.8, loadY: -0.5, loadX: 0, loadRotY: 0, scrim: 0.9, envRamp: false, preExplode: 0.14 },
  v6: { loadScale: 0.72, loadY: 0.05, loadX: 1.55, loadRotY: 0.9, scrim: 0, envRamp: true, envFloor: 0.28, envCeil: 0.6, dark: true, preExplode: 0.06, split: true, benefits: true },
};

// Services-section content ridden into the teardown as sequential callouts.
// Windows [in, out] are on scene progress; each anchors to the moving part.
export const HERO3D_BENEFITS = [
  { key: "delay", title: "Lower delay", desc: "Polling, drivers, power, and game settings lined up so the mouse tracks closer to your hand.", window: [0.2, 0.32] },
  { key: "fps", title: "More FPS", desc: "BIOS, Windows, GPU, RAM, and in-game settings tuned around the titles you play most.", window: [0.33, 0.45] },
  { key: "frames", title: "Stable frames", desc: "1% lows and frametimes tightened so fights feel smooth and the counter matches it.", window: [0.46, 0.58] },
  { key: "junk", title: "Less junk running", desc: "Cleaner startup, lighter overlays, and power behavior that leaves room for the game.", window: [0.59, 0.71] },
  { key: "sustain", title: "FPS stays up", desc: "Heat, boost, RAM, and stability dialed in so the PC keeps pace deep into the session.", window: [0.72, 0.84] },
];

const FIN_COUNT = 30;
const BLADE_COUNT = 11;
const PARTICLE_COUNT = 130;

function readThemeColors() {
  const fallback = { accent: "#22d3ee", glow: "#03e9f4" };
  if (typeof window === "undefined") return fallback;
  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--color-accent").trim();
  const glow = styles.getPropertyValue("--color-accent-glow").trim();
  return {
    accent: accent || fallback.accent,
    glow: glow || fallback.glow,
  };
}

function makeRadialTexture(inner, mid) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  gradient.addColorStop(0, inner);
  gradient.addColorStop(0.55, mid);
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Procedural studio lighting so PBR metals read correctly without any
// network-loaded HDR assets.
function StudioEnvironment() {
  const { gl, scene } = useThree();

  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const envScene = new RoomEnvironment();
    const envMap = pmrem.fromScene(envScene, 0.04).texture;
    scene.environment = envMap;
    return () => {
      scene.environment = null;
      envMap.dispose();
      pmrem.dispose();
    };
  }, [gl, scene]);

  return null;
}

function DepthParticles({ progressRef, colors }) {
  const pointsRef = useRef(null);

  const positions = useMemo(() => {
    const array = new Float32Array(PARTICLE_COUNT * 3);
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      array[i * 3] = (Math.random() - 0.5) * 16;
      array[i * 3 + 1] = (Math.random() - 0.5) * 10;
      array[i * 3 + 2] = -3 - Math.random() * 7;
    }
    return array;
  }, []);

  useFrame((state) => {
    if (!pointsRef.current) return;
    const t = state.clock.elapsedTime;
    // Background layer drifts slower than the subject: parallax depth.
    pointsRef.current.position.y =
      Math.sin(t * 0.12) * 0.25 + progressRef.current * 1.4;
    pointsRef.current.rotation.z = t * 0.008;
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial
        color={colors.accent}
        size={0.035}
        sizeAttenuation
        transparent
        opacity={0.4}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function Fan({ position, materials, spinRef, glowTexture, glowRef }) {
  const bladesRef = useRef(null);
  const glowMeshRef = useRef(null);

  useFrame(() => {
    if (bladesRef.current) bladesRef.current.rotation.y = spinRef.current;
    if (glowMeshRef.current) {
      const level = glowRef.current;
      glowMeshRef.current.material.opacity = 0.12 + level * 0.4;
      const scale = 1.05 + level * 0.35;
      glowMeshRef.current.scale.set(scale, scale, 1);
    }
  });

  const blades = useMemo(
    () =>
      Array.from({ length: BLADE_COUNT }, (_, i) => ({
        angle: (i / BLADE_COUNT) * Math.PI * 2,
        key: `blade-${i}`,
      })),
    []
  );

  return (
    <group position={position}>
      <mesh
        ref={glowMeshRef}
        position={[0, -0.02, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[1.1, 1.1]} />
        <meshBasicMaterial
          map={glowTexture}
          transparent
          opacity={0.15}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={materials.accentRing}>
        <torusGeometry args={[0.34, 0.02, 12, 48]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={materials.well}>
        <torusGeometry args={[0.3, 0.018, 10, 40]} />
      </mesh>
      <mesh material={materials.hub}>
        <cylinderGeometry args={[0.1, 0.1, 0.09, 24]} />
      </mesh>
      <mesh position={[0, 0.05, 0]} material={materials.blade}>
        <cylinderGeometry args={[0.065, 0.075, 0.02, 24]} />
      </mesh>
      <group ref={bladesRef}>
        {blades.map(({ angle, key }) => (
          <group key={key} rotation={[0, angle, 0]}>
            <mesh
              position={[0.2, 0, 0]}
              rotation={[0, 0.3, 0.3]}
              material={materials.blade}
            >
              <boxGeometry args={[0.24, 0.016, 0.1]} />
            </mesh>
            <mesh
              position={[0.27, 0.012, 0.028]}
              rotation={[0, 0.52, 0.34]}
              material={materials.blade}
            >
              <boxGeometry args={[0.12, 0.014, 0.08]} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

function EnvRamp({ progressRef, variant }) {
  const { scene } = useThree();

  useFrame(() => {
    if (!variant.envRamp) {
      scene.environmentIntensity = 1;
      return;
    }
    const floor = variant.envFloor ?? 0.12;
    const ceil = variant.envCeil ?? 1;
    const heroP = heroPhase(progressRef.current);
    scene.environmentIntensity = floor + (1 - heroP) * (ceil - floor);
  });

  return null;
}

function CameraRig({ progressRef, variant }) {
  const { camera, size } = useThree();

  useFrame(() => {
    const sceneP = scenePhase(progressRef.current);
    const explode = variant.benefits
      ? pulse(sceneP, 0.16, 0.37, 0.85, 0.93)
      : pulse(sceneP, 0.16, 0.44, 0.52, 0.72);
    const payoff = variant.benefits
      ? smoothstep(sceneP, 0.93, 0.985)
      : smoothstep(sceneP, 0.74, 0.92);
    // Keep the whole card in frame on narrower aspects (16:10 laptops).
    const aspect = size.width / size.height;
    const fit =
      aspect < 1.7
        ? (1.7 - aspect) * 1.6
        : aspect > 1.85
          ? (aspect - 1.85) * 1.5
          : 0;
    camera.position.z = 7.4 + fit + explode * 0.7 - payoff * 0.55;
    camera.position.y = 0.4 - payoff * 0.15;
    camera.lookAt(0, -0.1, 0);
  });

  return null;
}

function LogoDecal() {
  const texture = useLoader(THREE.TextureLoader, "/embed_logo.png");
  return (
    <mesh position={[0, 0.135, 0.42]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[0.62, 0.31]} />
      <meshBasicMaterial map={texture} transparent opacity={0.92} depthWrite={false} />
    </mesh>
  );
}

function GpuRig({ progressRef, colors, variant }) {
  const rigRef = useRef(null);
  const backplateRef = useRef(null);
  const pcbRef = useRef(null);
  const finsRef = useRef(null);
  const shroudRef = useRef(null);
  const fansRef = useRef(null);
  const shadowRef = useRef(null);
  const spinRef = useRef(0);
  const glowRef = useRef(0);
  const labelRefs = useRef([]);
  const calloutRefs = useRef([]);

  const materials = useMemo(() => {
    const accent = new THREE.Color(colors.accent);
    const dark = Boolean(variant.dark);
    return {
      // Matte composite shroud against bright machined metal separates the
      // plastic and metal reads instead of one uniform grey.
      shroud: new THREE.MeshPhysicalMaterial({
        color: dark ? "#141922" : "#1f2833",
        metalness: 0.25,
        roughness: 0.55,
        clearcoat: 0.35,
        clearcoatRoughness: 0.35,
        envMapIntensity: dark ? 0.6 : 0.9,
      }),
      backplate: new THREE.MeshPhysicalMaterial({
        color: dark ? "#1a212c" : "#2a333f",
        metalness: 0.9,
        roughness: 0.3,
        clearcoat: 0.4,
        clearcoatRoughness: 0.3,
        envMapIntensity: 0.85,
      }),
      pcb: new THREE.MeshStandardMaterial({
        color: "#0e131a",
        metalness: 0.3,
        roughness: 0.7,
        envMapIntensity: 0.4,
      }),
      fin: new THREE.MeshStandardMaterial({
        color: "#4a5663",
        metalness: 0.95,
        roughness: 0.32,
        envMapIntensity: 1.1,
      }),
      hub: new THREE.MeshStandardMaterial({
        color: "#161d26",
        metalness: 0.7,
        roughness: 0.4,
        envMapIntensity: 0.7,
      }),
      blade: new THREE.MeshStandardMaterial({
        color: "#39434f",
        metalness: 0.5,
        roughness: 0.45,
        envMapIntensity: 0.8,
      }),
      chip: new THREE.MeshStandardMaterial({
        color: "#0b0f14",
        emissive: accent,
        emissiveIntensity: 0.5,
      }),
      accentRing: new THREE.MeshStandardMaterial({
        color: "#0b0f14",
        emissive: accent,
        emissiveIntensity: 0.8,
      }),
      accentStrip: new THREE.MeshStandardMaterial({
        color: "#0b0f14",
        emissive: accent,
        emissiveIntensity: 1.1,
      }),
      gold: new THREE.MeshStandardMaterial({
        color: "#d4a537",
        metalness: 1,
        roughness: 0.35,
        envMapIntensity: 1.2,
      }),
      copper: new THREE.MeshStandardMaterial({
        color: "#b46a3a",
        metalness: 1,
        roughness: 0.3,
        envMapIntensity: 1.15,
      }),
      well: new THREE.MeshStandardMaterial({
        color: "#0a0e13",
        metalness: 0.4,
        roughness: 0.7,
      }),
    };
  }, [colors.accent, variant.dark]);

  const shadowTexture = useMemo(
    () => makeRadialTexture("rgba(0,0,0,0.55)", "rgba(0,0,0,0.2)"),
    []
  );
  const glowTexture = useMemo(
    () => makeRadialTexture("rgba(80,230,255,0.9)", "rgba(30,160,220,0.25)"),
    []
  );

  const fins = useMemo(
    () =>
      Array.from({ length: FIN_COUNT }, (_, i) => ({
        x: -1.35 + (i / (FIN_COUNT - 1)) * 2.7,
        key: `fin-${i}`,
      })),
    []
  );

  const chips = useMemo(
    () => [
      { position: [0, 0.06, 0], size: [0.42, 0.05, 0.42] },
      { position: [-1.0, 0.05, 0.3], size: [0.28, 0.04, 0.34] },
      { position: [-1.0, 0.05, -0.25], size: [0.28, 0.04, 0.34] },
      { position: [0.95, 0.05, 0.35], size: [0.4, 0.04, 0.2] },
      { position: [1.05, 0.05, -0.3], size: [0.24, 0.04, 0.24] },
    ],
    []
  );

  useFrame((state, delta) => {
    const rawP = progressRef.current;
    const heroP = heroPhase(rawP);
    const p = scenePhase(rawP);
    const t = state.clock.elapsedTime;

    // Staggered layer choreography: fans lead, backplate trails. The
    // benefits stage holds the explosion open across all five beats.
    const breathe =
      variant.preExplode * heroP * (0.8 + Math.sin(t * 1.5) * 0.2);
    const holdOut = variant.benefits ? [0.84, 0.92] : [0.52, 0.7];
    const explodeFans = Math.min(
      1,
      pulse(p, 0.14, 0.34, holdOut[0], holdOut[1]) + breathe
    );
    const explodeShroud = Math.min(
      1,
      pulse(p, 0.16, 0.37, holdOut[0] + 0.01, holdOut[1] + 0.01) + breathe * 0.8
    );
    const explodeFins = Math.min(
      1,
      pulse(p, 0.18, 0.4, holdOut[0] + 0.02, holdOut[1] + 0.02) + breathe * 0.6
    );
    const explodePlate = Math.min(
      1,
      pulse(p, 0.2, 0.43, holdOut[0] + 0.03, holdOut[1] + 0.03) + breathe * 0.5
    );
    const explode = explodeShroud;
    const payoff = variant.benefits
      ? smoothstep(p, 0.93, 0.985)
      : smoothstep(p, 0.7, 0.88);
    const snap = variant.benefits
      ? pulse(p, 0.9, 0.93, 0.95, 0.98)
      : pulse(p, 0.66, 0.7, 0.73, 0.78);

    if (rigRef.current) {
      // While the hero copy overlays the scene the card holds its variant
      // load pose, then moves to center stage as the copy scrolls away.
      const scale = variant.loadScale + (1 - heroP) * (1 - variant.loadScale);
      rigRef.current.scale.set(scale, scale, scale);
      rigRef.current.rotation.y =
        0.7 +
        p * 1.9 +
        variant.loadRotY * heroP +
        t * heroP * 0.05 +
        Math.sin(t * 0.4) * 0.03;
      rigRef.current.rotation.x = 0.32 + Math.sin(t * 0.55) * 0.015;
      rigRef.current.position.x = variant.loadX * heroP;
      rigRef.current.position.y =
        Math.sin(t * 0.7) * 0.04 - 0.05 + heroP * (variant.loadY + 0.05) - explode * 0.55;
    }

    if (backplateRef.current)
      backplateRef.current.position.y = -0.2 - explodePlate * 0.65;
    if (pcbRef.current) pcbRef.current.position.y = -0.12 - explodePlate * 0.25;
    if (finsRef.current) finsRef.current.position.y = 0.12 + explodeFins * 0.55;
    if (shroudRef.current)
      shroudRef.current.position.y = 0.44 + explodeShroud * 1.0;
    if (fansRef.current) {
      fansRef.current.position.y = 0.6 + explodeFans * 1.45;
      fansRef.current.position.z = explodeFans * 0.25;
    }

    spinRef.current += delta * (1.2 + payoff * 26);
    glowRef.current = payoff;

    const glowLevel = 0.35 + payoff * 2.0 + explode * 0.15 + snap * 1.4;
    materials.accentRing.emissiveIntensity = glowLevel;
    materials.accentStrip.emissiveIntensity = 0.7 + payoff * 1.6 + snap * 1.2;
    materials.chip.emissiveIntensity =
      0.35 + explode * 0.5 + payoff * 0.8 + snap * 0.7;

    if (shadowRef.current) {
      shadowRef.current.material.opacity = 0.62 - explode * 0.25;
      const spread = 1 + explode * 0.35;
      shadowRef.current.scale.set(spread, spread, 1);
    }

    const labelPhases = variant.benefits
      ? HERO3D_BENEFITS.map((b) =>
          pulse(p, b.window[0], b.window[0] + 0.02, b.window[1] - 0.02, b.window[1])
        )
      : [
          pulse(p, 0.2, 0.27, 0.5, 0.58),
          pulse(p, 0.26, 0.33, 0.5, 0.58),
          pulse(p, 0.32, 0.39, 0.5, 0.58),
        ];
    labelRefs.current.forEach((el, i) => {
      if (el) el.style.opacity = labelPhases[i].toFixed(3);
    });
    calloutRefs.current.forEach((group, i) => {
      if (group) group.visible = (labelPhases[i] || 0) > 0.02;
    });
  });

  const setLabelRef = (index) => (el) => {
    labelRefs.current[index] = el;
  };

  const setCalloutRef = (index) => (group) => {
    calloutRefs.current[index] = group;
  };

  const labelStyle = {
    color: "var(--color-text-primary, #fff)",
    background: "rgba(5, 9, 15, 0.92)",
    border: "1px solid rgba(148, 163, 184, 0.25)",
    borderLeft: "3px solid var(--color-accent, #22d3ee)",
    borderRadius: "4px",
    padding: "7px 14px",
    fontSize: "13px",
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
    opacity: 0,
    transition: "opacity 120ms linear",
    pointerEvents: "none",
  };

  const Callout = ({ side, y, children, index, desc }) => {
    const dir = side === "left" ? -1 : 1;
    const lineLen = 0.58;
    const edgeX = dir * 1.68;
    return (
      <group ref={setCalloutRef(index)} visible={false}>
        <mesh position={[edgeX, y, 0]} material={materials.accentRing}>
          <sphereGeometry args={[0.035, 12, 12]} />
        </mesh>
        <mesh
          position={[edgeX + (dir * lineLen) / 2, y, 0]}
          rotation={[0, 0, Math.PI / 2]}
          material={materials.accentRing}
        >
          <cylinderGeometry args={[0.008, 0.008, lineLen, 6]} />
        </mesh>
        <Html
          position={[edgeX + dir * lineLen, y, 0]}
          zIndexRange={[20, 0]}
        >
          <div
            ref={setLabelRef(index)}
            style={{
              ...labelStyle,
              ...(desc ? { whiteSpace: "normal", width: "252px" } : null),
              borderLeft:
                dir === 1
                  ? "3px solid var(--color-accent, #22d3ee)"
                  : "1px solid rgba(148, 163, 184, 0.25)",
              borderRight:
                dir === -1
                  ? "3px solid var(--color-accent, #22d3ee)"
                  : "1px solid rgba(148, 163, 184, 0.25)",
              backdropFilter: "blur(6px)",
              background: "rgba(7, 12, 19, 0.82)",
              transform:
                dir === 1 ? "translate(0, -50%)" : "translate(-100%, -50%)",
            }}
          >
            {typeof index === "number" && desc && (
              <span
                style={{
                  color: "var(--color-accent, #22d3ee)",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: "11px",
                  marginRight: "8px",
                  letterSpacing: "0.12em",
                }}
              >
                {String(index + 1).padStart(2, "0")}
              </span>
            )}
            {children}
            {desc && (
              <span
                style={{
                  display: "block",
                  marginTop: "5px",
                  fontSize: "12px",
                  fontWeight: 500,
                  letterSpacing: "0.01em",
                  textTransform: "none",
                  color: "rgba(226, 236, 248, 0.85)",
                  lineHeight: 1.45,
                }}
              >
                {desc}
              </span>
            )}
          </div>
        </Html>
      </group>
    );
  };

  return (
    <group ref={rigRef}>
      <group ref={backplateRef}>
        <RoundedBox
          args={[3.25, 0.06, 1.38]}
          radius={0.025}
          smoothness={2}
          material={materials.backplate}
        />
        {[[-1.5, 0.62], [1.5, 0.62], [-1.5, -0.62], [1.5, -0.62]].map(
          ([sx, sz]) => (
            <mesh
              key={`screw-${sx}-${sz}`}
              position={[sx, 0.035, sz]}
              material={materials.hub}
            >
              <cylinderGeometry args={[0.035, 0.035, 0.015, 12]} />
            </mesh>
          )
        )}
        {[-0.9, -0.7, -0.5].map((vx) => (
          <mesh
            key={`vent-${vx}`}
            position={[vx, 0.032, -0.45]}
            rotation={[0, 0.5, 0]}
            material={materials.well}
          >
            <boxGeometry args={[0.3, 0.012, 0.05]} />
          </mesh>
        ))}
        <mesh position={[1.2, 0.01, 0]} material={materials.accentStrip}>
          <boxGeometry args={[0.5, 0.07, 0.05]} />
        </mesh>
        {variant.benefits ? (
          <Callout side="left" y={0.3} index={0} desc={HERO3D_BENEFITS[0].desc}>
            {HERO3D_BENEFITS[0].title}
          </Callout>
        ) : (
          <Callout side="left" y={0.25} index={2}>
            Windows & driver debloat
          </Callout>
        )}
      </group>

      <group ref={pcbRef}>
        <mesh material={materials.pcb}>
          <boxGeometry args={[3.1, 0.07, 1.3]} />
        </mesh>
        {Array.from({ length: 14 }, (_, i) => (
          <mesh
            key={`finger-${i}`}
            position={[-0.5 + i * 0.09, -0.02, 0.66]}
            material={materials.gold}
          >
            <boxGeometry args={[0.055, 0.035, 0.06]} />
          </mesh>
        ))}
        {chips.map((chip, i) => (
          <mesh
            key={`chip-${i}`}
            position={chip.position}
            material={materials.chip}
          >
            <boxGeometry args={chip.size} />
          </mesh>
        ))}
        {variant.benefits ? (
          <Callout side="right" y={0.15} index={1} desc={HERO3D_BENEFITS[1].desc}>
            {HERO3D_BENEFITS[1].title}
          </Callout>
        ) : (
          <Callout side="right" y={0.1} index={0}>
            BIOS & NVRAM tuning
          </Callout>
        )}
      </group>

      <group ref={finsRef}>
        {fins.map(({ x, key }) => (
          <mesh key={key} position={[x, 0, 0]} material={materials.fin}>
            <boxGeometry args={[0.024, 0.34, 1.22]} />
          </mesh>
        ))}
        {[-0.28, 0, 0.28].map((pz) => (
          <mesh
            key={`pipe-${pz}`}
            position={[0, -0.14, pz]}
            rotation={[0, 0, Math.PI / 2]}
            material={materials.copper}
          >
            <cylinderGeometry args={[0.045, 0.045, 3.0, 16]} />
          </mesh>
        ))}
        {variant.benefits ? (
          <Callout side="left" y={0.2} index={2} desc={HERO3D_BENEFITS[2].desc}>
            {HERO3D_BENEFITS[2].title}
          </Callout>
        ) : (
          <Callout side="left" y={0.15} index={1}>
            Thermals & fan curves
          </Callout>
        )}
      </group>

      <group ref={shroudRef}>
        <RoundedBox
          args={[3.35, 0.26, 1.46]}
          radius={0.045}
          smoothness={3}
          material={materials.shroud}
        />
        <mesh position={[-0.78, 0.11, 0]} material={materials.well}>
          <cylinderGeometry args={[0.42, 0.42, 0.06, 36]} />
        </mesh>
        <mesh position={[0.78, 0.11, 0]} material={materials.well}>
          <cylinderGeometry args={[0.42, 0.42, 0.06, 36]} />
        </mesh>
        <mesh
          position={[1.52, 0.09, 0]}
          rotation={[0, 0, -0.5]}
          material={materials.accentStrip}
        >
          <boxGeometry args={[0.5, 0.03, 1.3]} />
        </mesh>
        <mesh position={[0, 0.02, 0.72]} material={materials.accentStrip}>
          <boxGeometry args={[3.1, 0.05, 0.04]} />
        </mesh>
        <mesh position={[0, 0.02, -0.72]} material={materials.accentStrip}>
          <boxGeometry args={[3.1, 0.05, 0.04]} />
        </mesh>
        <mesh position={[-1.45, 0.05, 0.6]} material={materials.accentStrip}>
          <boxGeometry args={[0.32, 0.06, 0.1]} />
        </mesh>
        <Suspense fallback={null}>
          <LogoDecal />
        </Suspense>
        <group position={[0.6, 0.12, -0.55]}>
          <mesh material={materials.well}>
            <boxGeometry args={[0.42, 0.1, 0.2]} />
          </mesh>
          {Array.from({ length: 8 }, (_, i) => (
            <mesh
              key={`pin-${i}`}
              position={[-0.155 + (i % 4) * 0.1, 0.045, -0.045 + Math.floor(i / 4) * 0.09]}
              material={materials.hub}
            >
              <cylinderGeometry args={[0.022, 0.022, 0.03, 8]} />
            </mesh>
          ))}
        </group>
        {variant.benefits && (
          <Callout side="right" y={0.1} index={3} desc={HERO3D_BENEFITS[3].desc}>
            {HERO3D_BENEFITS[3].title}
          </Callout>
        )}
      </group>

      <group ref={fansRef}>
        <Fan
          position={[-0.78, 0, 0]}
          materials={materials}
          spinRef={spinRef}
          glowTexture={glowTexture}
          glowRef={glowRef}
        />
        <Fan
          position={[0.78, 0, 0]}
          materials={materials}
          spinRef={spinRef}
          glowTexture={glowTexture}
          glowRef={glowRef}
        />
        {variant.benefits && (
          <Callout side="left" y={0.05} index={4} desc={HERO3D_BENEFITS[4].desc}>
            {HERO3D_BENEFITS[4].title}
          </Callout>
        )}
      </group>

      <mesh position={[0, -1.72, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[3.4, 48]} />
        <meshStandardMaterial
          color="#0a1526"
          metalness={0.6}
          roughness={0.55}
          transparent
          opacity={0.5}
        />
      </mesh>
      <mesh
        ref={shadowRef}
        position={[0, -1.7, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[5.2, 3.4]} />
        <meshBasicMaterial
          map={shadowTexture}
          transparent
          depthWrite={false}
          opacity={0.6}
        />
      </mesh>
    </group>
  );
}

export default function HeroScene3D({ progressRef, active, variantKey }) {
  const colors = useMemo(() => readThemeColors(), []);
  const variant = HERO3D_VARIANTS[variantKey] || HERO3D_VARIANTS.v1;

  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ fov: 40, position: [0, 0.4, 7.4] }}
      style={{ position: "absolute", inset: 0 }}
    >
      <fog attach="fog" args={["#060d1f", 9, 20]} />
      <StudioEnvironment />
      <EnvRamp progressRef={progressRef} variant={variant} />
      <CameraRig progressRef={progressRef} variant={variant} />
      <ambientLight intensity={0.22} />
      <spotLight
        position={[0, 6, 3]}
        angle={0.55}
        penumbra={0.8}
        intensity={40}
        color="#e8f2ff"
      />
      <directionalLight position={[4, 5, 5]} intensity={0.9} />
      <pointLight position={[-5, 2, -4]} intensity={14} color={colors.glow} />
      <pointLight position={[5, 1, -3]} intensity={9} color={colors.glow} />
      <DepthParticles progressRef={progressRef} colors={colors} />
      <GpuRig progressRef={progressRef} colors={colors} variant={variant} />
    </Canvas>
  );
}
