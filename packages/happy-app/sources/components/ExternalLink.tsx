import { Link } from 'expo-router';
import React from 'react';
import { Platform } from 'react-native';
import { openExternalUrl } from '@/utils/openExternalUrl';

export function ExternalLink(
  props: Omit<React.ComponentProps<typeof Link>, 'href'> & { href: string }
) {
  return (
    <Link
      target="_blank"
      {...props}
      href={props.href as any}
      onPress={(e) => {
        if (Platform.OS !== 'web') {
          e.preventDefault();
          void openExternalUrl(props.href as string);
        }
      }}
    />
  );
}
