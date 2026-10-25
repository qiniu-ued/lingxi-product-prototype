import { Button, Checkbox, Select, TextArea, TextField, Theme } from '@radix-ui/themes';
import {
  Children,
  type ComponentProps,
  createContext,
  isValidElement,
  type ReactNode,
  useContext,
} from 'react';
import '@radix-ui/themes/styles.css';
import './settings.css';

const SettingsControls = createContext(false);

export function SettingsTheme({ children }: { children: ReactNode }) {
  return (
    <SettingsControls.Provider value={true}>
      <Theme
        appearance="light"
        accentColor="bronze"
        grayColor="sand"
        radius="large"
        panelBackground="solid"
        className="settings-theme"
      >
        {children}
      </Theme>
    </SettingsControls.Provider>
  );
}

export function WorkbenchTheme({ children }: { children: ReactNode }) {
  return (
    <SettingsControls.Provider value={true}>
      <Theme
        appearance="light"
        accentColor="bronze"
        grayColor="sand"
        radius="large"
        className="workbench-theme"
      >
        {children}
      </Theme>
    </SettingsControls.Provider>
  );
}

export function ConfigurationButton({
  variant = 'surface',
  ...props
}: Omit<ComponentProps<'button'>, 'color'> & Pick<ComponentProps<typeof Button>, 'variant'>) {
  return useContext(SettingsControls) ? (
    <Button size="2" variant={variant} {...props} />
  ) : (
    <button {...props} />
  );
}

type InputProps = Omit<
  ComponentProps<'input'>,
  'color' | 'size' | 'type' | 'value' | 'defaultValue'
> &
  Pick<TextField.RootProps, 'type' | 'value' | 'defaultValue'>;

export function ConfigurationInput(props: InputProps) {
  return useContext(SettingsControls) ? (
    <TextField.Root size="3" {...props} />
  ) : (
    <input {...props} />
  );
}

export function ConfigurationTextArea(props: ComponentProps<typeof TextArea>) {
  return useContext(SettingsControls) ? <TextArea size="3" {...props} /> : <textarea {...props} />;
}

export function ConfigurationSelect({
  children,
  value,
  onValueChange,
  disabled,
  ...props
}: Pick<
  ComponentProps<'select'>,
  'id' | 'className' | 'aria-label' | 'aria-labelledby' | 'title' | 'name' | 'disabled' | 'children'
> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  const themed = useContext(SettingsControls);
  if (!themed)
    return (
      <select
        {...props}
        disabled={disabled}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {children}
      </select>
    );
  const empty = '__lingxi_empty_option__';
  const items = Children.toArray(children).filter(
    (child) => isValidElement<ComponentProps<'option'>>(child) && child.type === 'option',
  );
  return (
    <Select.Root
      value={value || empty}
      onValueChange={(next) => onValueChange(next === empty ? '' : next)}
      {...(disabled === undefined ? {} : { disabled })}
    >
      <Select.Trigger {...props} variant="surface" />
      <Select.Content position="popper">
        {items.map((child) => {
          if (!isValidElement<ComponentProps<'option'>>(child)) return null;
          const option = child.props;
          return (
            <Select.Item
              key={String(option.value ?? '')}
              value={String(option.value ?? '') || empty}
              {...(option.disabled === undefined ? {} : { disabled: option.disabled })}
            >
              {option.children}
            </Select.Item>
          );
        })}
      </Select.Content>
    </Select.Root>
  );
}

export function ConfigurationCheckbox({
  id,
  checked,
  onCheckedChange,
}: {
  id?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return useContext(SettingsControls) ? (
    <Checkbox
      id={id}
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
    />
  ) : (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  );
}
