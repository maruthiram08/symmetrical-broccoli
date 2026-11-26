import type { MetadataRoute } from "next";
import { appManifest } from "@/lib/platform/manifest";

export default function manifest(): MetadataRoute.Manifest {
  return appManifest();
}
