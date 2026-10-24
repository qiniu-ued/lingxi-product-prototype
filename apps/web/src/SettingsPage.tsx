import { SetupPage } from './SetupPage';

export function SettingsPage({ onClose }: { onClose: () => void }) {
  return <SetupPage mode="settings" onContinue={onClose} />;
}
