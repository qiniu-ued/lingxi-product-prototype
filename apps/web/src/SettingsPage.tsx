import type { SetupInspection } from '@lingxi/protocol';
import { SettingsTheme } from './ConfigurationControls';
import { SetupPage } from './SetupPage';

export function SettingsPage({
  onClose,
  initialInspection,
  selectMissing,
}: {
  onClose: () => void;
  initialInspection: SetupInspection | null;
  selectMissing: boolean;
}) {
  return (
    <SettingsTheme>
      <SetupPage
        initialInspection={initialInspection}
        selectMissing={selectMissing}
        onContinue={onClose}
      />
    </SettingsTheme>
  );
}
