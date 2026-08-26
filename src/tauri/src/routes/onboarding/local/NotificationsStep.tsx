import { DiscordSettings } from "../../../components/DiscordSettings";
import "../../../components/formFields.css";

export function NotificationsStep({ root }: { root: string }) {
  return <DiscordSettings root={root} />;
}
