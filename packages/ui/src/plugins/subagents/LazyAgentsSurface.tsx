import React from 'react';

/** The Agents panel, loaded when first opened. */
export const AgentsSurface = React.lazy(() => import('./AgentsSurface').then((module) => ({ default: module.AgentsSurface })));
