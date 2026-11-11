import React from 'react';

import {
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { parseUpdateChannel, type UpdateChannel } from '@/lib/updateChannel';

const UPDATE_CHANNEL_LABELS: Record<UpdateChannel, string> = {
  stable: 'Stable',
  rc: 'Release candidate',
};

export const UpdateChannelSelect: React.FC<{
  channel: UpdateChannel;
  disabled: boolean;
  label: string;
  onChange: (channel: string) => void;
}> = ({ channel, disabled, label, onChange }) => (
  <Select value={channel} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger
      size={SETTINGS_SELECT_SIZE}
      className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
      aria-label={label}
    >
      <SelectValue>{(value) => UPDATE_CHANNEL_LABELS[parseUpdateChannel(value)]}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      <SelectItem value="stable">{UPDATE_CHANNEL_LABELS.stable}</SelectItem>
      <SelectItem value="rc">{UPDATE_CHANNEL_LABELS.rc}</SelectItem>
    </SelectContent>
  </Select>
);
