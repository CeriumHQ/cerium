import type { DeviceInfo } from "@cerium/protocol";
import { Globe, Monitor, Server, Smartphone, type LucideProps } from "lucide-react";

export function DeviceIcon({ device, ...props }: LucideProps & { device?: DeviceInfo | undefined }) {
  if (device?.kind === "browser") {
    return device.platform === "ios" || device.platform === "android" ? (
      <Smartphone {...props} />
    ) : (
      <Globe {...props} />
    );
  }
  return device?.headless === true ? <Server {...props} /> : <Monitor {...props} />;
}
