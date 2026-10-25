import { createContext, type ReactNode, useContext } from 'react';
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
  variant = 'ghost',
  icon,
}: {
  section?: SettingsSection;
  label?: string;
  variant?: 'ghost' | 'surface';
  icon?: ReactNode;
}) {
  const navigation = useContext(Navigation);
  return (
    <ConfigurationButton
      type="button"
      className="settings-link"
      variant={variant}
      onClick={() => navigation.settings(section)}
    >
      {icon}
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
