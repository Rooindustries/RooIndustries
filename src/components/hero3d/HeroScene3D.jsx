import React, { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html } from "@react-three/drei";
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

const FIN_COUNT = 22;
const BLADE_COUNT = 9;
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

function CameraRig({ progressRef }) {
  const { camera, size } = useThree();

  useFrame(() => {
    const sceneP = scenePhase(progressRef.current);
    const explode = pulse(sceneP, 0.16, 0.44, 0.52, 0.72);
    const payoff = smoothstep(sceneP, 0.74, 0.92);
    // Keep the whole card in frame on narrower aspects (16:10 laptops).
    const aspect = size.width / size.height;
    const fit = aspect < 1.7 ? (1.7 - aspect) * 1.6 : 0;
    camera.position.z = 7.4 + fit + explode * 0.7 - payoff * 0.9;
    camera.position.y = 0.4 - payoff * 0.15;
    camera.lookAt(0, -0.1, 0);
  });

  return null;
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
  const glowRef = useRef(0);
  const labelRefs = useRef([]);

  const materials = useMemo(() => {
    const accent = new THREE.Color(colors.accent);
    return {
      shroud: new THREE.MeshPhysicalMaterial({
        color: "#1f2833",
        metalness: 0.85,
        roughness: 0.38,
        clearcoat: 0.6,
        clearcoatRoughness: 0.25,
        envMapIntensity: 0.9,
      }),
      backplate: new THREE.MeshPhysicalMaterial({
        color: "#2a333f",
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
    };
  }, [colors.accent]);

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

    // Staggered layer choreography: fans lead, backplate trails.
    const explodeFans = pulse(p, 0.15, 0.4, 0.52, 0.7);
    const explodeShroud = pulse(p, 0.18, 0.43, 0.53, 0.71);
    const explodeFins = pulse(p, 0.21, 0.46, 0.54, 0.72);
    const explodePlate = pulse(p, 0.24, 0.49, 0.55, 0.73);
    const explode = explodeShroud;
    const payoff = smoothstep(p, 0.7, 0.88);
    const snap = pulse(p, 0.66, 0.7, 0.73, 0.78);

    if (rigRef.current) {
      // While the hero copy overlays the scene the card idles low and small,
      // then rises to center stage as the copy scrolls away.
      const scale = 0.62 + (1 - heroP) * 0.38;
      rigRef.current.scale.set(scale, scale, scale);
      rigRef.current.rotation.y = 0.7 + p * 1.9 + t * heroP * 0.05 + Math.sin(t * 0.4) * 0.03;
      rigRef.current.rotation.x = 0.32 + Math.sin(t * 0.55) * 0.015;
      rigRef.current.position.y =
        Math.sin(t * 0.7) * 0.04 - 0.05 - heroP * 1.55 - explode * 0.55;
    }

    if (backplateRef.current)
      backplateRef.current.position.y = -0.2 - explodePlate * 0.85;
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
          <mesh
            key={`chip-${i}`}
            position={chip.position}
            material={materials.chip}
          >
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
      <StudioEnvironment />
      <CameraRig progressRef={progressRef} />
      <ambientLight intensity={0.25} />
      <directionalLight position={[4, 5, 5]} intensity={1.1} />
      <pointLight position={[-5, 2, -4]} intensity={14} color={colors.glow} />
      <DepthParticles progressRef={progressRef} colors={colors} />
      <GpuRig progressRef={progressRef} colors={colors} />
    </Canvas>
  );
}
