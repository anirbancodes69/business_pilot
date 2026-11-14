import type { ReactNode } from 'react';

// A small inline icon set (no icon library, ui-standards §1). 24px grid, 1.75px stroke.
function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconPlus = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);
export const IconSend = () => (
  <Icon>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const IconCopy = () => (
  <Icon>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h8" />
  </Icon>
);
export const IconDownload = () => (
  <Icon>
    <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
  </Icon>
);
export const IconCheck = () => (
  <Icon>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const IconClose = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const IconMenu = () => (
  <Icon>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);
export const IconTable = () => (
  <Icon>
    <rect x="3.5" y="5" width="17" height="14" rx="2" />
    <path d="M3.5 10h17M9 5v14" />
  </Icon>
);
export const IconChart = () => (
  <Icon>
    <path d="M5 20V10M12 20V4M19 20v-7" />
  </Icon>
);
export const IconInfo = () => (
  <Icon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8v.01" />
  </Icon>
);
export const IconShield = () => (
  <Icon>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);
export const IconAlert = () => (
  <Icon>
    <path d="M12 4l9 16H3L12 4z" />
    <path d="M12 10v4M12 17v.01" />
  </Icon>
);
export const IconArrow = ({ dir }: { dir: 'up' | 'down' | 'flat' }) => (
  <Icon size={14}>
    {dir === 'up' ? (
      <path d="M12 19V5M6 11l6-6 6 6" />
    ) : dir === 'down' ? (
      <path d="M12 5v14M6 13l6 6 6-6" />
    ) : (
      <path d="M5 12h14" />
    )}
  </Icon>
);

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--brand)" />
      <path d="M9 22V13M16 22V9M23 22v-6" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
