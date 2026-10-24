import { createContext, useContext } from 'react';

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
    <button type="button" className="settings-link" onClick={() => navigation.settings(section)}>
      {label}
    </button>
  );
}
export function SetupLink({ label = '连接向导' }: { label?: string }) {
  const navigation = useContext(Navigation);
  return (
    <button type="button" onClick={navigation.setup}>
      {label}
    </button>
  );
}
