import { createContext, type ReactNode, useContext } from 'react';
import { ConfigurationButton } from './ConfigurationControls';

export type SettingsSection = 'codex' | 'lingxi' | 'wake';
export const Navigation = createContext({
  settings: (section?: SettingsSection) => location.assign(`/setup${section ? `#${section}` : ''}`),
});
export function SettingsLink({
  section,
  label = '连接向导',
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
