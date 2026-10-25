import { SettingsTheme } from './ConfigurationControls';
import { SetupPage } from './SetupPage';

export function SettingsPage({ onClose }: { onClose: () => void }) {
  return (
    <SettingsTheme>
      <SetupPage mode="settings" onContinue={onClose} />
    </SettingsTheme>
  );
}
