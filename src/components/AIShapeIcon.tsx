interface AIShapeIconProps {
  shape: number;
  color: string;
  size?: number;
  selected?: boolean;
}

export function AIShapeIcon({ shape, color, size = 14, selected = false }: AIShapeIconProps) {
  const stroke = selected ? '#facc15' : '#0b0f17';
  const sw = selected ? 1.8 : 1.1;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className="shrink-0"
      aria-hidden="true"
    >
      {shape === 0 && <circle cx="10" cy="10" r="7" fill={color} stroke={stroke} strokeWidth={sw} />}
      {shape === 1 && (
        <rect x="3" y="3" width="14" height="14" fill={color} stroke={stroke} strokeWidth={sw} />
      )}
      {shape === 2 && (
        <polygon points="10,2 2,17 18,17" fill={color} stroke={stroke} strokeWidth={sw} />
      )}
      {shape === 3 && (
        <polygon points="10,2 18,10 10,18 2,10" fill={color} stroke={stroke} strokeWidth={sw} />
      )}
      {shape === 4 && (
        <polygon points="2,3 18,3 10,18" fill={color} stroke={stroke} strokeWidth={sw} />
      )}
      {shape === 5 && (
        <path
          d="M7 2 H13 V7 H18 V13 H13 V18 H7 V13 H2 V7 H7 Z"
          fill={color}
          stroke={stroke}
          strokeWidth={sw}
        />
      )}
      {shape === 6 && (
        <>
          <circle cx="10" cy="10" r="7" fill={color} stroke={stroke} strokeWidth={sw} />
          <circle cx="10" cy="10" r="3" fill="#090c11" />
        </>
      )}
      {shape === 7 && (
        <polygon
          points="10,2 18,8 15,18 5,18 2,8"
          fill={color}
          stroke={stroke}
          strokeWidth={sw}
        />
      )}
    </svg>
  );
}
