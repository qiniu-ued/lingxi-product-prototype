import { createContext, useContext } from 'react';
import { ConfigurationButton } from './ConfigurationControls';

export type SettingsSection = 'codex' | 'lingxi' | 'wake';
export const Navigation = createContext({
  settings: (section?: SettingsSection) =>
    location.assign(`/settings${section ? `#${section}` : ''}`),
  setup: () => location.assign('/setup'),
});
export function SettingsLink({
  section,
  label = '设置',
}: {
  section?: SettingsSection;
  label?: string;
}) {
  const navigation = useContext(Navigation);
  return (
    <ConfigurationButton
      type="button"
      className="settings-link"
      variant="ghost"
      onClick={() => navigation.settings(section)}
    >
      {label}
    </ConfigurationButton>
  );
}
export function SetupLink({ label = '连接向导' }: { label?: string }) {
  const navigation = useContext(Navigation);
  return (
    <ConfigurationButton type="button" onClick={navigation.setup}>
      {label}
    </ConfigurationButton>
  );
}
