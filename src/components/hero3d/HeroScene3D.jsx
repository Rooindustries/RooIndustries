import React, { useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

const smoothstep = (value, edge0, edge1) => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

// Rises across [inStart, inEnd], holds at 1, falls back across [outStart, outEnd].
const pulse = (p, inStart, inEnd, outStart, outEnd) =>
  smoothstep(p, inStart, inEnd) * (1 - smoothstep(p, outStart, outEnd));

const FIN_COUNT = 22;
const BLADE_COUNT = 9;

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

function makeShadowTexture() {
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
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(0.6, "rgba(0,0,0,0.22)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function Fan({ position, materials, spinRef }) {
  const bladesRef = useRef(null);

  useFrame(() => {
    if (bladesRef.current) bladesRef.current.rotation.y = spinRef.current;
  });

  const blades = useMemo(
    () =>
      Array.from({ length: BLADE_COUNT }, (_, i) => {
        const angle = (i / BLADE_COUNT) * Math.PI * 2;
        return { angle, key: `blade-${i}` };
      }),
    []
  );

  return (
    <group position={position}>
      <mesh rotation={[Math.PI / 2, 0, 0]} material={materials.accentRing}>
        <torusGeometry args={[0.34, 0.02, 12, 48]} />
      </mesh>
      <mesh material={materials.hub}>
        <cylinderGeometry args={[0.1, 0.1, 0.09, 24]} />
      </mesh>
      <group ref={bladesRef}>
        {blades.map(({ angle, key }) => (
          <group key={key} rotation={[0, angle, 0]}>
            <mesh
              position={[0.21, 0, 0]}
              rotation={[0, 0.32, 0.18]}
              material={materials.blade}
            >
              <boxGeometry args={[0.26, 0.02, 0.11]} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

function GpuRig({ progressRef, colors }) {
  const rigRef = useRef(null);
  const backplateRef = useRef(null);
  const pcbRef = useRef(null);
  const finsRef = useRef(null);
  const shroudRef = useRef(null);
  const fansRef = useRef(null);
  const shadowRef = useRef(null);
  const spinRef = useRef(0);
  const labelRefs = useRef([]);

  const materials = useMemo(() => {
    const accent = new THREE.Color(colors.accent);
    return {
      shroud: new THREE.MeshStandardMaterial({
        color: "#242e3a",
        metalness: 0.55,
        roughness: 0.5,
      }),
      backplate: new THREE.MeshStandardMaterial({
        color: "#2b3541",
        metalness: 0.7,
        roughness: 0.38,
      }),
      pcb: new THREE.MeshStandardMaterial({
        color: "#10151c",
        metalness: 0.35,
        roughness: 0.62,
      }),
      fin: new THREE.MeshStandardMaterial({
        color: "#46525f",
        metalness: 0.8,
        roughness: 0.3,
      }),
      hub: new THREE.MeshStandardMaterial({
        color: "#141a21",
        metalness: 0.6,
        roughness: 0.5,
      }),
      blade: new THREE.MeshStandardMaterial({
        color: "#414d5b",
        metalness: 0.4,
        roughness: 0.5,
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
    };
  }, [colors.accent]);

  const shadowTexture = useMemo(() => makeShadowTexture(), []);

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
    const p = progressRef.current;
    const t = state.clock.elapsedTime;

    const explode = pulse(p, 0.16, 0.44, 0.52, 0.72);
    const payoff = smoothstep(p, 0.74, 0.92);

    if (rigRef.current) {
      rigRef.current.rotation.y = 0.7 + p * 1.9 + Math.sin(t * 0.4) * 0.03;
      rigRef.current.rotation.x = 0.32 + Math.sin(t * 0.55) * 0.015;
      rigRef.current.position.y =
        Math.sin(t * 0.7) * 0.04 - 0.05 - explode * 0.55;
    }

    if (backplateRef.current) backplateRef.current.position.y = -0.42 - explode * 0.7;
    if (pcbRef.current) pcbRef.current.position.y = -0.18;
    if (finsRef.current) finsRef.current.position.y = 0.12 + explode * 0.55;
    if (shroudRef.current) shroudRef.current.position.y = 0.46 + explode * 1.0;
    if (fansRef.current) {
      fansRef.current.position.y = 0.62 + explode * 1.45;
      fansRef.current.position.z = explode * 0.25;
    }

    spinRef.current += delta * (1.2 + payoff * 26);

    const glowLevel = 0.35 + payoff * 2.0 + explode * 0.15;
    materials.accentRing.emissiveIntensity = glowLevel;
    materials.accentStrip.emissiveIntensity = 0.7 + payoff * 1.6;
    materials.chip.emissiveIntensity = 0.35 + explode * 0.5 + payoff * 0.8;

    if (shadowRef.current) {
      shadowRef.current.material.opacity = 0.62 - explode * 0.25;
      const spread = 1 + explode * 0.35;
      shadowRef.current.scale.set(spread, spread, 1);
    }

    const labelPhases = [
      pulse(p, 0.2, 0.27, 0.5, 0.58),
      pulse(p, 0.26, 0.33, 0.5, 0.58),
      pulse(p, 0.32, 0.39, 0.5, 0.58),
    ];
    labelRefs.current.forEach((el, i) => {
      if (el) el.style.opacity = labelPhases[i].toFixed(3);
    });
  });

  const setLabelRef = (index) => (el) => {
    labelRefs.current[index] = el;
  };

  const labelStyle = {
    color: "var(--color-text-primary, #fff)",
    background: "rgba(6, 10, 16, 0.9)",
    border: "1px solid var(--color-border-accent, rgba(103,232,249,0.3))",
    borderRadius: "8px",
    padding: "6px 12px",
    fontSize: "14px",
    fontWeight: 600,
    letterSpacing: "0.02em",
    whiteSpace: "nowrap",
    opacity: 0,
    transition: "opacity 120ms linear",
    pointerEvents: "none",
  };

  return (
    <group ref={rigRef}>
      <group ref={backplateRef}>
        <mesh material={materials.backplate}>
          <boxGeometry args={[3.25, 0.06, 1.38]} />
        </mesh>
        <mesh position={[1.2, 0.01, 0]} material={materials.accentStrip}>
          <boxGeometry args={[0.5, 0.07, 0.05]} />
        </mesh>
        <Html position={[-2.15, 0, 0]} center zIndexRange={[20, 0]}>
          <div ref={setLabelRef(2)} style={labelStyle}>
            Windows & driver debloat
          </div>
        </Html>
      </group>

      <group ref={pcbRef}>
        <mesh material={materials.pcb}>
          <boxGeometry args={[3.1, 0.07, 1.3]} />
        </mesh>
        {chips.map((chip, i) => (
          <mesh key={`chip-${i}`} position={chip.position} material={materials.chip}>
            <boxGeometry args={chip.size} />
          </mesh>
        ))}
        <Html position={[2.15, 0, 0]} center zIndexRange={[20, 0]}>
          <div ref={setLabelRef(0)} style={labelStyle}>
            BIOS & NVRAM tuning
          </div>
        </Html>
      </group>

      <group ref={finsRef}>
        {fins.map(({ x, key }) => (
          <mesh key={key} position={[x, 0, 0]} material={materials.fin}>
            <boxGeometry args={[0.035, 0.34, 1.22]} />
          </mesh>
        ))}
        <Html position={[-2.15, 0.1, 0]} center zIndexRange={[20, 0]}>
          <div ref={setLabelRef(1)} style={labelStyle}>
            Thermals & fan curves
          </div>
        </Html>
      </group>

      <group ref={shroudRef}>
        <mesh material={materials.shroud}>
          <boxGeometry args={[3.35, 0.26, 1.46]} />
        </mesh>
        <mesh position={[0, 0.02, 0.72]} material={materials.accentStrip}>
          <boxGeometry args={[3.1, 0.05, 0.04]} />
        </mesh>
        <mesh position={[0, 0.02, -0.72]} material={materials.accentStrip}>
          <boxGeometry args={[3.1, 0.05, 0.04]} />
        </mesh>
      </group>

      <group ref={fansRef}>
        <Fan position={[-0.78, 0, 0]} materials={materials} spinRef={spinRef} />
        <Fan position={[0.78, 0, 0]} materials={materials} spinRef={spinRef} />
      </group>

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

export default function HeroScene3D({ progressRef, active }) {
  const colors = useMemo(() => readThemeColors(), []);

  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      camera={{ fov: 40, position: [0, 0.4, 7.4] }}
      style={{ position: "absolute", inset: 0 }}
    >
      <ambientLight intensity={0.75} />
      <hemisphereLight args={["#aac2ff", "#131a24", 0.8]} />
      <directionalLight position={[4, 5, 5]} intensity={2.3} />
      <directionalLight position={[-3, 2, 4]} intensity={0.9} color="#cfe0ff" />
      <pointLight position={[0, 1.5, 6]} intensity={14} color="#dfe9ff" />
      <pointLight position={[-5, 2, -4]} intensity={16} color={colors.glow} />
      <GpuRig progressRef={progressRef} colors={colors} />
    </Canvas>
  );
}
