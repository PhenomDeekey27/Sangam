import { cn } from "@/lib/utils";

/** Number of flow dots travelling the arch. */
const DOTS = 5;
/** Seconds a dot takes to cross, and the stagger between dots. */
const CROSS_SECONDS = 2.2;
const STAGGER_SECONDS = 0.44;

/** Direction of translation flow along the bridge. */
export type BridgeFlow = "none" | "a-to-b" | "b-to-a";

interface Geometry {
  readonly viewBox: string;
  readonly forward: string;
  readonly reverse: string;
  readonly mid: { readonly x: number; readonly y: number };
  readonly svgClass: string;
}

/*
 * Two arch geometries. `forward` runs speaker A -> B, `reverse` is the same
 * curve walked the other way, so no SMIL `keyPoints` reversal is needed.
 * `mid` is the apex of the quadratic curve (t = 0.5), used for the resting
 * dot and for punching the "broken" gap.
 */
const HORIZONTAL: Geometry = {
  viewBox: "0 0 240 64",
  forward: "M 10 54 Q 120 2 230 54",
  reverse: "M 230 54 Q 120 2 10 54",
  mid: { x: 120, y: 28 },
  svgClass: "h-16 w-full max-w-[260px]",
};

const VERTICAL: Geometry = {
  viewBox: "0 0 64 176",
  forward: "M 32 14 Q 4 88 32 162",
  reverse: "M 32 162 Q 4 88 32 14",
  mid: { x: 18, y: 88 },
  svgClass: "h-36 w-16",
};

export interface VoiceBridgeProps {
  readonly flow: BridgeFlow;
  readonly orientation?: "horizontal" | "vertical";
  /** Arch is severed: partner left, mic denied, or the connection failed. */
  readonly broken?: boolean;
  /** Translation pill, e.g. "Translating English → Tamil". */
  readonly label?: string;
  readonly className?: string;
}

/**
 * The signature Sangam element: an arch joining two speakers with dots that
 * flow toward the listener. SVG + SMIL only — no animation dependency.
 */
export function VoiceBridge({
  flow,
  orientation = "horizontal",
  broken = false,
  label,
  className,
}: VoiceBridgeProps) {
  const geometry = orientation === "horizontal" ? HORIZONTAL : VERTICAL;
  const flowing = flow !== "none" && !broken;

  return (
    <div
      className={cn(
        "relative flex items-center justify-center",
        orientation === "horizontal" ? "w-full" : "w-16",
        className,
      )}
    >
      <svg
        viewBox={geometry.viewBox}
        aria-hidden="true"
        className={cn(
          "overflow-visible",
          geometry.svgClass,
          broken && "opacity-60",
        )}
      >
        <path
          d={geometry.forward}
          fill="none"
          stroke={flowing ? "var(--bridge)" : "var(--line)"}
          strokeWidth={flowing ? 2 : 1.5}
          strokeLinecap="round"
          strokeDasharray={flowing ? "3 7" : "2 7"}
        />

        {broken ? (
          <circle
            cx={geometry.mid.x}
            cy={geometry.mid.y}
            r={8}
            fill="var(--bg)"
          />
        ) : null}

        <g className="bridge-flow">
          {Array.from({ length: DOTS }, (_, index) => (
            <circle key={index} r={4} fill="var(--bridge)">
              <animateMotion
                dur={`${CROSS_SECONDS}s`}
                begin={`${(index * STAGGER_SECONDS).toFixed(2)}s`}
                repeatCount="indefinite"
                path={flow === "b-to-a" ? geometry.reverse : geometry.forward}
              />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.12;0.86;1"
                dur={`${CROSS_SECONDS}s`}
                begin={`${(index * STAGGER_SECONDS).toFixed(2)}s`}
                repeatCount="indefinite"
              />
            </circle>
          ))}
        </g>

        {!broken ? (
          <g className="bridge-rest">
            <circle
              cx={geometry.mid.x}
              cy={geometry.mid.y}
              r={4}
              fill="var(--bridge)"
            />
          </g>
        ) : null}
      </svg>

      {label ? (
        <span
          className={cn(
            "glass pop text-ink shadow-soft pointer-events-none absolute top-1/2 left-1/2 max-w-[15rem] -translate-x-1/2 -translate-y-1/2 rounded-full px-3 py-1 text-center text-[11px] leading-tight font-medium",
          )}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
