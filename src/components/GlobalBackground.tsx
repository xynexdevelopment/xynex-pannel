import React, { useEffect } from 'react';
import { useSettings } from '../context/SettingsContext';

export function GlobalBackground() {
  const { panelBackgroundImage, panelBackgroundBlur } = useSettings();

  // Let CSS know a custom bg is active so panels can turn translucent
  useEffect(() => {
    const root = document.documentElement;
    if (panelBackgroundImage) root.classList.add('has-panel-bg');
    else root.classList.remove('has-panel-bg');
    return () => root.classList.remove('has-panel-bg');
  }, [panelBackgroundImage]);

  if (!panelBackgroundImage) return null;

  return (
    <div 
      className="fixed inset-0 z-[-1] bg-cover bg-center bg-no-repeat"
      style={{ 
        backgroundImage: `url(${panelBackgroundImage})`,
        filter: `blur(${panelBackgroundBlur || 0}px)`,
        transform: 'scale(1.1)', // To prevent blurred edges from showing the background behind it
      }}
    >
      <div className="absolute inset-0 bg-background/25" /> {/* Light overlay – keeps text readable but image visible */}
    </div>
  );
}
