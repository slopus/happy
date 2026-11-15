import {
  LOGO_BODY_PATH,
  LOGO_LEFT_HAND_PATH,
  LOGO_RIGHT_HAND_PATH,
  LOGO_AVATAR_LIGHTING as lighting,
  logoAvatarPaint,
} from "@rakazo/core";
import { memo } from "react";

/** Fully vector body. The photographic grain is intentionally simplified. */
export const LogoAvatarBody = memo(function LogoAvatarBody({
  id,
  color,
  originalOrange,
}: {
  id: string;
  color: string;
  originalOrange: boolean;
}) {
  const paint = logoAvatarPaint(color, originalOrange);
  return (
    <g className="logo-avatar-art">
      <defs>
        <clipPath id={`body-clip-${id}`}>
          <path d={LOGO_BODY_PATH} />
        </clipPath>
        <radialGradient id={`body-fill-${id}`} {...lighting.body}>
          <stop stopColor={paint.base} />
          <stop offset=".48" stopColor={paint.base} />
          <stop offset="1" stopColor={paint.edge} />
        </radialGradient>
        <radialGradient id={`body-shade-${id}`} {...lighting.flank}>
          <stop stopColor={paint.flank} stopOpacity=".94" />
          <stop offset=".4" stopColor={paint.flank} stopOpacity=".94" />
          <stop offset=".65" stopColor={paint.flank} stopOpacity=".76" />
          <stop offset=".85" stopColor={paint.flank} stopOpacity=".22" />
          <stop offset="1" stopColor={paint.flank} stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={`body-light-${id}`}
          gradientUnits={lighting.crown.gradientUnits}
          cx={lighting.crown.cx}
          cy={lighting.crown.cy}
          r={lighting.crown.r}
          gradientTransform={lighting.crown.gradientTransform}
        >
          <stop stopColor="white" stopOpacity={lighting.crown.peak} />
          <stop offset=".4" stopColor="white" stopOpacity={lighting.crown.shoulder} />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`hand-left-${id}`} {...lighting.leftHand}>
          <stop stopColor={paint.base} />
          <stop offset=".28" stopColor={paint.base} />
          <stop offset="1" stopColor={paint.shadow} />
        </radialGradient>
        <radialGradient id={`hand-right-${id}`} {...lighting.rightHand}>
          <stop stopColor={paint.base} />
          <stop offset=".28" stopColor={paint.base} />
          <stop offset="1" stopColor={paint.shadow} />
        </radialGradient>
        <radialGradient
          id={`hand-left-light-${id}`}
          {...lighting.leftHand}
          r={lighting.handLight.radius}
        >
          <stop stopColor="white" stopOpacity={lighting.handLight.leftPeak} />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient
          id={`hand-right-light-${id}`}
          {...lighting.rightHand}
          r={lighting.handLight.radius}
        >
          <stop stopColor="white" stopOpacity={lighting.handLight.rightPeak} />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`hand-left-shadow-${id}`} {...lighting.leftContact}>
          <stop stopColor={paint.contact} stopOpacity=".72" />
          <stop offset=".45" stopColor={paint.contact} stopOpacity=".64" />
          <stop offset=".65" stopColor={paint.contact} stopOpacity=".3" />
          <stop offset=".9" stopColor={paint.contact} stopOpacity=".04" />
          <stop offset="1" stopColor={paint.contact} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`hand-right-shadow-${id}`} {...lighting.rightContact}>
          <stop stopColor={paint.contact} stopOpacity=".72" />
          <stop offset=".45" stopColor={paint.contact} stopOpacity=".64" />
          <stop offset=".65" stopColor={paint.contact} stopOpacity=".3" />
          <stop offset=".9" stopColor={paint.contact} stopOpacity=".04" />
          <stop offset="1" stopColor={paint.contact} stopOpacity="0" />
        </radialGradient>
        <linearGradient
          id={`rim-direction-${id}`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="100"
          y2="0"
        >
          <stop stopColor="white" stopOpacity=".25" />
          <stop offset=".5" stopColor="white" stopOpacity=".72" />
          <stop offset="1" stopColor="white" />
        </linearGradient>
        <linearGradient
          id={`rim-lower-fade-${id}`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="100"
        >
          <stop stopColor="white" stopOpacity="0" />
          <stop offset=".36" stopColor="white" stopOpacity="0" />
          <stop offset=".58" stopColor="white" />
          <stop offset="1" stopColor="white" />
        </linearGradient>
        <linearGradient
          id={`rim-upper-cut-${id}`}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="0"
          y2="100"
        >
          <stop stopColor="black" stopOpacity="0" />
          <stop offset=".36" stopColor="black" stopOpacity="0" />
          <stop offset=".58" stopColor="black" />
          <stop offset="1" stopColor="black" />
        </linearGradient>
        <mask
          id={`rim-upper-mask-${id}`}
          maskUnits="userSpaceOnUse"
          style={{ maskType: "luminance" }}
          x="0"
          y="0"
          width="100"
          height="110"
        >
          <rect width="100" height="110" fill={`url(#rim-direction-${id})`} />
          <rect width="100" height="110" fill={`url(#rim-upper-cut-${id})`} />
          <rect width="100" height="110" fill={`url(#rim-left-trim-${id})`} />
        </mask>
        <mask
          id={`rim-lower-mask-${id}`}
          maskUnits="userSpaceOnUse"
          style={{ maskType: "luminance" }}
          x="0"
          y="0"
          width="100"
          height="110"
        >
          <rect width="100" height="110" fill={`url(#rim-lower-fade-${id})`} />
        </mask>
        <radialGradient id={`rim-left-trim-${id}`} {...lighting.rimLeftTrim}>
          <stop stopColor="black" stopOpacity=".6" />
          <stop offset=".9" stopColor="black" stopOpacity=".6" />
          <stop offset=".94" stopColor="black" stopOpacity=".5" />
          <stop offset=".965" stopColor="black" stopOpacity="0" />
          <stop offset="1" stopColor="black" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`rim-upper-${id}`} {...lighting.rimUpper}>
          <stop stopColor={paint.rim} stopOpacity="0" />
          <stop offset=".818" stopColor={paint.rim} stopOpacity="0" />
          <stop offset=".855" stopColor={paint.rim} stopOpacity=".035" />
          <stop offset=".882" stopColor={paint.rim} stopOpacity=".14" />
          <stop offset=".9" stopColor={paint.rim} stopOpacity=".42" />
          <stop offset=".918" stopColor={paint.rim} stopOpacity=".53" />
          <stop offset=".941" stopColor={paint.rim} stopOpacity=".2" />
          <stop offset=".973" stopColor={paint.rim} stopOpacity="0" />
          <stop offset="1" stopColor={paint.rim} stopOpacity="0" />
        </radialGradient>
        {(["Left", "Right"] as const).map((side) => (
          <radialGradient
            key={side}
            id={`rim-${side.toLowerCase()}-${id}`}
            {...lighting[side === "Left" ? "rimLeft" : "rimRight"]}
          >
            <stop stopColor={paint.rim} stopOpacity="0" />
            <stop offset=".873" stopColor={paint.rim} stopOpacity="0" />
            <stop offset=".891" stopColor={paint.rim} stopOpacity={side === "Left" ? 0.22 : 0.46} />
            <stop offset=".912" stopColor={paint.rim} stopOpacity={side === "Left" ? 0.22 : 0.46} />
            <stop offset=".93" stopColor={paint.rim} stopOpacity={side === "Left" ? 0.1 : 0.2} />
            <stop offset=".955" stopColor={paint.rim} stopOpacity="0" />
            <stop offset="1" stopColor={paint.rim} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      <path d={LOGO_BODY_PATH} fill={`url(#body-fill-${id})`} />
      <path d={LOGO_BODY_PATH} fill={`url(#body-shade-${id})`} />
      <path d={LOGO_BODY_PATH} fill={`url(#body-light-${id})`} />
      <g clipPath={`url(#body-clip-${id})`}>
        <path
          d={LOGO_BODY_PATH}
          fill={`url(#rim-upper-${id})`}
          mask={`url(#rim-upper-mask-${id})`}
        />
        <g mask={`url(#rim-lower-mask-${id})`}>
          <path d={LOGO_BODY_PATH} fill={`url(#rim-left-${id})`} />
          <path d={LOGO_BODY_PATH} fill={`url(#rim-right-${id})`} />
        </g>
        <path d={LOGO_BODY_PATH} fill={`url(#hand-left-shadow-${id})`} />
        <path d={LOGO_BODY_PATH} fill={`url(#hand-right-shadow-${id})`} />
        <path d={LOGO_LEFT_HAND_PATH} fill={`url(#hand-left-${id})`} />
        <path d={LOGO_RIGHT_HAND_PATH} fill={`url(#hand-right-${id})`} />
        <path d={LOGO_LEFT_HAND_PATH} fill={`url(#hand-left-light-${id})`} />
        <path d={LOGO_RIGHT_HAND_PATH} fill={`url(#hand-right-light-${id})`} />
      </g>
    </g>
  );
});
