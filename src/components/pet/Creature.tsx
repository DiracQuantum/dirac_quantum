"use client";

/**
 * The body of the pet: a real 3D model when the form has one, otherwise the
 * depth-animated picture. ?catdebug=1 always shows the picture rig so the
 * regions can still be tuned. `model` (from ?model=<path>, see PetBody) tests
 * any GLB under public/models in place of the form's own.
 */

import dynamic from "next/dynamic";
import { rigFor } from "@/lib/petForms";

const DepthCreature = dynamic(() => import("@/components/three/DepthCreature"), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});
const ModelCreature = dynamic(() => import("@/components/three/ModelCreature"), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

export default function Creature({
  form,
  debug = false,
  tint = "#ffffff",
  model = null,
}: {
  form: string;
  debug?: boolean;
  tint?: string;
  /** a GLB path that overrides the form's model (testing aid) */
  model?: string | null;
}) {
  const { rig, borrowed } = rigFor(form);
  const url = model ?? (rig.model && !borrowed ? rig.model : null);
  if (url && !debug) return <ModelCreature url={url} tint={tint} yaw={rig.modelYaw ?? 0} />;
  return <DepthCreature form={form} debug={debug} tint={tint} />;
}
