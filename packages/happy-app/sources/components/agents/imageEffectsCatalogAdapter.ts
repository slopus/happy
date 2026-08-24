// Generated from the pinned image-effects build snapshot. Do not edit entries by hand.
import snapshot from './imageEffectsCatalogSnapshot.json';
import type { ImageAgentStyleCategory, ImageAgentStylePreset } from './imageStyleTypes';

export type ImageEffectsCatalogSnapshot = typeof snapshot;
export const IMAGE_EFFECTS_CATALOG_SNAPSHOT: ImageEffectsCatalogSnapshot = snapshot;

// <image-effects-category-meta>
const CATEGORY_META: Record<string, { label: string; accent: string }> = Object.freeze({
    "academic-figures": {
        "label": "学术配图",
        "accent": "#1A4E8A"
    },
    "assets-and-props": {
        "label": "素材资产",
        "accent": "#6B5B95"
    },
    "avatars-and-profile": {
        "label": "头像人设",
        "accent": "#D08C60"
    },
    "branding-and-packaging": {
        "label": "品牌包装",
        "accent": "#B8860B"
    },
    "editing-workflows": {
        "label": "图像编辑",
        "accent": "#4A6FA5"
    },
    "editorial": {
        "label": "编辑设计",
        "accent": "#B34732"
    },
    "grids-and-collages": {
        "label": "网格拼贴",
        "accent": "#2E7D8B"
    },
    "infographics": {
        "label": "信息图",
        "accent": "#D4665A"
    },
    "maps": {
        "label": "地图",
        "accent": "#3B7A57"
    },
    "portrait": {
        "label": "人物",
        "accent": "#315D86"
    },
    "portraits-and-characters": {
        "label": "人物视觉",
        "accent": "#8B4513"
    },
    "poster-and-campaigns": {
        "label": "海报营销",
        "accent": "#E8472C"
    },
    "product-visuals": {
        "label": "产品视觉",
        "accent": "#C7522A"
    },
    "scenes-and-illustrations": {
        "label": "氛围插画",
        "accent": "#5E8B7E"
    },
    "slides-and-visual-docs": {
        "label": "视觉文档",
        "accent": "#6A4C93"
    },
    "storyboards-and-sequences": {
        "label": "叙事序列",
        "accent": "#A23E48"
    },
    "technical-diagrams": {
        "label": "技术图示",
        "accent": "#0A6E96"
    },
    "typography-and-text-layout": {
        "label": "字体版式",
        "accent": "#4F4F4F"
    },
    "ui-mockups": {
        "label": "界面样机",
        "accent": "#1F6FB2"
    },
    "zine": {
        "label": "纸本杂志",
        "accent": "#7A6250"
    }
});
// </image-effects-category-meta>

export const IMAGE_EFFECTS_LEGACY_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    "academic-figures/graphical-abstract/1": "image-effects/graphical-abstract@1.0.0",
    "academic-figures/graphical-abstract/2": "image-effects/graphical-abstract@1.0.0",
    "academic-figures/mechanism-diagram/1": "image-effects/mechanism-diagram@1.0.0",
    "academic-figures/mechanism-diagram/2": "image-effects/mechanism-diagram@1.0.0",
    "academic-figures/method-pipeline-overview/1": "image-effects/method-pipeline-overview@1.0.0",
    "academic-figures/method-pipeline-overview/2": "image-effects/method-pipeline-overview@1.0.0",
    "academic-figures/multi-condition-comparison/1": "image-effects/multi-condition-comparison@1.0.0",
    "academic-figures/multi-condition-comparison/2": "image-effects/multi-condition-comparison@1.0.0",
    "academic-figures/neural-network-architecture/1": "image-effects/neural-network-architecture@1.0.0",
    "academic-figures/neural-network-architecture/2": "image-effects/neural-network-architecture@1.0.0",
    "academic-figures/publication-chart/1": "image-effects/publication-chart@1.0.0",
    "academic-figures/publication-chart/2": "image-effects/publication-chart@1.0.0",
    "academic-figures/qualitative-comparison-grid/1": "image-effects/qualitative-comparison-grid@1.0.0",
    "academic-figures/qualitative-comparison-grid/2": "image-effects/qualitative-comparison-grid@1.0.0",
    "academic-figures/research-overview-poster/1": "image-effects/research-overview-poster@1.0.0",
    "academic-figures/research-overview-poster/2": "image-effects/research-overview-poster@1.0.0",
    "academic-figures/scientific-schematic/1": "image-effects/scientific-schematic@1.0.0",
    "academic-figures/scientific-schematic/2": "image-effects/scientific-schematic@1.0.0",
    "assets-and-props/game-screenshot-mockup/1": "image-effects/game-screenshot-mockup@1.0.0",
    "assets-and-props/game-screenshot-mockup/2": "image-effects/game-screenshot-mockup@1.0.0",
    "assets-and-props/retro-skeuomorphic-icons/1": "image-effects/retro-skeuomorphic-icons@1.0.0",
    "assets-and-props/retro-skeuomorphic-icons/2": "image-effects/retro-skeuomorphic-icons@1.0.0",
    "avatars-and-profile/character-grid-portrait/1": "image-effects/character-grid-portrait@1.0.0",
    "avatars-and-profile/character-grid-portrait/2": "image-effects/character-grid-portrait@1.0.0",
    "avatars-and-profile/cultural-portrait-series/1": "image-effects/cultural-portrait-series@1.0.0",
    "avatars-and-profile/cultural-portrait-series/2": "image-effects/cultural-portrait-series@1.0.0",
    "avatars-and-profile/sticker-set/1": "image-effects/sticker-set@1.0.0",
    "avatars-and-profile/sticker-set/2": "image-effects/sticker-set@1.0.0",
    "avatars-and-profile/style-transfer-selfie/1": "image-effects/style-transfer-selfie@1.0.0",
    "avatars-and-profile/style-transfer-selfie/2": "image-effects/style-transfer-selfie@1.0.0",
    "avatars-and-profile/themed-3d-icon/1": "image-effects/themed-3d-icon@1.0.0",
    "avatars-and-profile/themed-3d-icon/2": "image-effects/themed-3d-icon@1.0.0",
    "branding-and-packaging/beverage-label-design/1": "image-effects/beverage-label-design@1.0.0",
    "branding-and-packaging/beverage-label-design/2": "image-effects/beverage-label-design@1.0.0",
    "branding-and-packaging/brand-identity-board/1": "image-effects/brand-identity-board@1.0.0",
    "branding-and-packaging/brand-identity-board/2": "image-effects/brand-identity-board@1.0.0",
    "branding-and-packaging/cosmetic-packaging/1": "image-effects/cosmetic-packaging@1.0.0",
    "branding-and-packaging/cosmetic-packaging/2": "image-effects/cosmetic-packaging@1.0.0",
    "branding-and-packaging/mascot-brand-kit/1": "image-effects/mascot-brand-kit@1.0.0",
    "branding-and-packaging/mascot-brand-kit/2": "image-effects/mascot-brand-kit@1.0.0",
    "editing-workflows/background-replacement/1": "image-effects/background-replacement@1.0.0",
    "editing-workflows/background-replacement/2": "image-effects/background-replacement@1.0.0",
    "editing-workflows/local-object-replacement/1": "image-effects/local-object-replacement@1.0.0",
    "editing-workflows/local-object-replacement/2": "image-effects/local-object-replacement@1.0.0",
    "editing-workflows/object-removal/1": "image-effects/object-removal@1.0.0",
    "editing-workflows/object-removal/2": "image-effects/object-removal@1.0.0",
    "editing-workflows/portrait-local-edit/1": "image-effects/portrait-local-edit@1.0.0",
    "editing-workflows/portrait-local-edit/2": "image-effects/portrait-local-edit@1.0.0",
    "editing-workflows/product-retouching/1": "image-effects/product-retouching@1.0.0",
    "editing-workflows/product-retouching/2": "image-effects/product-retouching@1.0.0",
    "grids-and-collages/anime-pitch-board/1": "image-effects/anime-pitch-board@1.0.0",
    "grids-and-collages/anime-pitch-board/2": "image-effects/anime-pitch-board@1.0.0",
    "grids-and-collages/banner-grid-2x2/1": "image-effects/banner-grid-2x2@1.0.0",
    "grids-and-collages/banner-grid-2x2/2": "image-effects/banner-grid-2x2@1.0.0",
    "grids-and-collages/lookbook-grid/1": "image-effects/lookbook-grid@1.0.0",
    "grids-and-collages/lookbook-grid/2": "image-effects/lookbook-grid@1.0.0",
    "grids-and-collages/mixed-style-multi-panel/1": "image-effects/mixed-style-multi-panel@1.0.0",
    "grids-and-collages/mixed-style-multi-panel/2": "image-effects/mixed-style-multi-panel@1.0.0",
    "infographics/bento-grid-infographic/1": "image-effects/bento-grid-infographic@1.0.0",
    "infographics/bento-grid-infographic/2": "image-effects/bento-grid-infographic@1.0.0",
    "infographics/comparison-infographic/1": "image-effects/comparison-infographic@1.0.0",
    "infographics/comparison-infographic/2": "image-effects/comparison-infographic@1.0.0",
    "infographics/hand-drawn-infographic/1": "image-effects/hand-drawn-infographic@1.0.0",
    "infographics/hand-drawn-infographic/2": "image-effects/hand-drawn-infographic@1.0.0",
    "infographics/kpi-dashboard-infographic/1": "image-effects/kpi-dashboard-infographic@1.0.0",
    "infographics/kpi-dashboard-infographic/2": "image-effects/kpi-dashboard-infographic@1.0.0",
    "infographics/legend-heavy-infographic/1": "image-effects/legend-heavy-infographic@1.0.0",
    "infographics/legend-heavy-infographic/2": "image-effects/legend-heavy-infographic@1.0.0",
    "infographics/step-by-step-infographic/1": "image-effects/step-by-step-infographic@1.0.0",
    "infographics/step-by-step-infographic/2": "image-effects/step-by-step-infographic@1.0.0",
    "maps/food-map/1": "image-effects/food-map@1.0.0",
    "maps/food-map/2": "image-effects/food-map@1.0.0",
    "maps/illustrated-city-map/1": "image-effects/illustrated-city-map@1.0.0",
    "maps/illustrated-city-map/2": "image-effects/illustrated-city-map@1.0.0",
    "maps/store-distribution-map/1": "image-effects/store-distribution-map@1.0.0",
    "maps/store-distribution-map/2": "image-effects/store-distribution-map@1.0.0",
    "maps/travel-route-map/1": "image-effects/travel-route-map@1.0.0",
    "maps/travel-route-map/2": "image-effects/travel-route-map@1.0.0",
    "portraits-and-characters/character-sheet/1": "image-effects/character-sheet@1.0.0",
    "portraits-and-characters/character-sheet/2": "image-effects/character-sheet@1.0.0",
    "portraits-and-characters/founder-portrait/1": "image-effects/founder-portrait@1.0.0",
    "portraits-and-characters/founder-portrait/2": "image-effects/founder-portrait@1.0.0",
    "portraits-and-characters/professional-portrait/1": "image-effects/professional-portrait@1.0.0",
    "portraits-and-characters/professional-portrait/2": "image-effects/professional-portrait@1.0.0",
    "portraits-and-characters/virtual-host/1": "image-effects/virtual-host@1.0.0",
    "portraits-and-characters/virtual-host/2": "image-effects/virtual-host@1.0.0",
    "poster-and-campaigns/banner-hero/1": "image-effects/banner-hero@1.0.0",
    "poster-and-campaigns/banner-hero/2": "image-effects/banner-hero@1.0.0",
    "poster-and-campaigns/banner-hero/3": "image-effects/banner-hero@1.0.0",
    "poster-and-campaigns/brand-poster/1": "image-effects/brand-poster@1.0.0",
    "poster-and-campaigns/brand-poster/2": "image-effects/brand-poster@1.0.0",
    "poster-and-campaigns/campaign-kv/1": "image-effects/campaign-kv@1.0.0",
    "poster-and-campaigns/campaign-kv/2": "image-effects/campaign-kv@1.0.0",
    "poster-and-campaigns/editorial-cover/1": "image-effects/editorial-cover@1.0.0",
    "poster-and-campaigns/editorial-cover/2": "image-effects/editorial-cover@1.0.0",
    "product-visuals/exploded-view-poster/1": "image-effects/exploded-view-poster@1.0.0",
    "product-visuals/exploded-view-poster/2": "image-effects/exploded-view-poster@1.0.0",
    "product-visuals/lifestyle-product-scene/1": "image-effects/lifestyle-product-scene@1.0.0",
    "product-visuals/lifestyle-product-scene/2": "image-effects/lifestyle-product-scene@1.0.0",
    "product-visuals/packaging-showcase/1": "image-effects/packaging-showcase@1.0.0",
    "product-visuals/packaging-showcase/2": "image-effects/packaging-showcase@1.0.0",
    "product-visuals/premium-studio-product/1": "image-effects/premium-studio-product@1.0.0",
    "product-visuals/premium-studio-product/2": "image-effects/premium-studio-product@1.0.0",
    "product-visuals/white-background-product/1": "image-effects/white-background-product@1.0.0",
    "product-visuals/white-background-product/2": "image-effects/white-background-product@1.0.0",
    "scenes-and-illustrations/concept-scene/1": "image-effects/concept-scene@1.0.0",
    "scenes-and-illustrations/concept-scene/2": "image-effects/concept-scene@1.0.0",
    "scenes-and-illustrations/healing-scene/1": "image-effects/healing-scene@1.0.0",
    "scenes-and-illustrations/healing-scene/2": "image-effects/healing-scene@1.0.0",
    "scenes-and-illustrations/minimalist-mood-scene/1": "image-effects/minimalist-mood-scene@1.0.0",
    "scenes-and-illustrations/minimalist-mood-scene/2": "image-effects/minimalist-mood-scene@1.0.0",
    "scenes-and-illustrations/picture-book-scene/1": "image-effects/picture-book-scene@1.0.0",
    "scenes-and-illustrations/picture-book-scene/2": "image-effects/picture-book-scene@1.0.0",
    "slides-and-visual-docs/dense-explainer-slides/1": "image-effects/dense-explainer-slides@1.0.0",
    "slides-and-visual-docs/dense-explainer-slides/2": "image-effects/dense-explainer-slides@1.0.0",
    "slides-and-visual-docs/educational-diagram-slide/1": "image-effects/educational-diagram-slide@1.0.0",
    "slides-and-visual-docs/educational-diagram-slide/2": "image-effects/educational-diagram-slide@1.0.0",
    "slides-and-visual-docs/policy-style-slide/1": "image-effects/policy-style-slide@1.0.0",
    "slides-and-visual-docs/policy-style-slide/2": "image-effects/policy-style-slide@1.0.0",
    "slides-and-visual-docs/visual-report-page/1": "image-effects/visual-report-page@1.0.0",
    "slides-and-visual-docs/visual-report-page/2": "image-effects/visual-report-page@1.0.0",
    "storyboards-and-sequences/anime-key-visual/1": "image-effects/anime-key-visual@1.0.0",
    "storyboards-and-sequences/anime-key-visual/2": "image-effects/anime-key-visual@1.0.0",
    "storyboards-and-sequences/character-relationship-diagram/1": "image-effects/character-relationship-diagram@1.0.0",
    "storyboards-and-sequences/character-relationship-diagram/2": "image-effects/character-relationship-diagram@1.0.0",
    "storyboards-and-sequences/four-panel-comic/1": "image-effects/four-panel-comic@1.0.0",
    "storyboards-and-sequences/four-panel-comic/2": "image-effects/four-panel-comic@1.0.0",
    "storyboards-and-sequences/manga-spread-page/1": "image-effects/manga-spread-page@1.0.0",
    "storyboards-and-sequences/manga-spread-page/2": "image-effects/manga-spread-page@1.0.0",
    "storyboards-and-sequences/recipe-process-flowchart/1": "image-effects/recipe-process-flowchart@1.0.0",
    "storyboards-and-sequences/recipe-process-flowchart/2": "image-effects/recipe-process-flowchart@1.0.0",
    "technical-diagrams/er-diagram/1": "image-effects/er-diagram@1.0.0",
    "technical-diagrams/er-diagram/2": "image-effects/er-diagram@1.0.0",
    "technical-diagrams/flowchart-decision/1": "image-effects/flowchart-decision@1.0.0",
    "technical-diagrams/flowchart-decision/2": "image-effects/flowchart-decision@1.0.0",
    "technical-diagrams/mind-map-tech/1": "image-effects/mind-map-tech@1.0.0",
    "technical-diagrams/mind-map-tech/2": "image-effects/mind-map-tech@1.0.0",
    "technical-diagrams/network-topology/1": "image-effects/network-topology@1.0.0",
    "technical-diagrams/network-topology/2": "image-effects/network-topology@1.0.0",
    "technical-diagrams/sequence-diagram/1": "image-effects/sequence-diagram@1.0.0",
    "technical-diagrams/sequence-diagram/2": "image-effects/sequence-diagram@1.0.0",
    "technical-diagrams/state-machine/1": "image-effects/state-machine@1.0.0",
    "technical-diagrams/state-machine/2": "image-effects/state-machine@1.0.0",
    "technical-diagrams/system-architecture/1": "image-effects/system-architecture@1.0.0",
    "technical-diagrams/system-architecture/2": "image-effects/system-architecture@1.0.0",
    "typography-and-text-layout/bilingual-layout-visual/1": "image-effects/bilingual-layout-visual@1.0.0",
    "typography-and-text-layout/bilingual-layout-visual/2": "image-effects/bilingual-layout-visual@1.0.0",
    "typography-and-text-layout/title-safe-poster/1": "image-effects/title-safe-poster@1.0.0",
    "typography-and-text-layout/title-safe-poster/2": "image-effects/title-safe-poster@1.0.0",
    "ui-mockups/chat-interface-scene/1": "image-effects/chat-interface-scene@1.0.0",
    "ui-mockups/chat-interface-scene/2": "image-effects/chat-interface-scene@1.0.0",
    "ui-mockups/chat-interface-scene/3": "image-effects/chat-interface-scene@1.0.0",
    "ui-mockups/live-commerce-ui/1": "image-effects/live-commerce-ui@1.0.0",
    "ui-mockups/live-commerce-ui/2": "image-effects/live-commerce-ui@1.0.0",
    "ui-mockups/product-card-overlay/1": "image-effects/product-card-overlay@1.0.0",
    "ui-mockups/product-card-overlay/2": "image-effects/product-card-overlay@1.0.0",
    "ui-mockups/short-video-cover-ui/1": "image-effects/short-video-cover-ui@1.0.0",
    "ui-mockups/short-video-cover-ui/2": "image-effects/short-video-cover-ui@1.0.0",
    "ui-mockups/short-video-cover-ui/3": "image-effects/short-video-cover-ui@1.0.0",
    "ui-mockups/social-interface-mockup/1": "image-effects/social-interface-mockup@1.0.0",
    "ui-mockups/social-interface-mockup/2": "image-effects/social-interface-mockup@1.0.0",
    "ui-mockups/social-interface-mockup/3": "image-effects/social-interface-mockup@1.0.0",
    "github-skills/gpt-image-2/1": "image-effects/healing-anime-scribble-v3@1.0.0",
    "github-skills/photo-illustration-diptych/3": "image-effects/photo-illustration-editorial-echo@1.0.0",
    "reference-torn-paper-editorial/torn-paper-photo-collage/1": "image-effects/torn-paper-editorial-photo-collage@1.0.0",
    "github-skills/photo-illustration-diptych/2": "image-effects/photo-illustration-diptych-lakeside@1.0.0",
    "github-skills/photo-illustration-diptych/1": "image-effects/photo-illustration-diptych@1.0.0",
    "github-skills/scenes-gathered-zine/2": "image-effects/scenes-gathered-zine-sea@1.0.0",
    "github-skills/scenes-gathered-zine/1": "image-effects/scenes-gathered-zine@1.0.0",
    "github-skills/scene-distillation-zine/1": "image-effects/scene-distillation-zine@1.0.0",
    "github-skills/minimal-zine-poster/1": "image-effects/minimal-zine-poster@1.0.0",
    "editing-workflows/vintage-film-editorial/1": "image-effects/vintage-film-editorial@1.0.0",
    "storyboards-and-sequences/product-tvc-storyboard/1": "image-effects/product-tvc-storyboard@1.0.0",
    "storyboards-and-sequences/cinematic-storyboard/1": "image-effects/cinematic-storyboard@1.0.0",
    "infographics/vintage-editorial-infographic/1": "image-effects/vintage-editorial-infographic@1.0.0",
    "branding-and-packaging/character-merch-board/1": "image-effects/character-merch-board@1.0.0",
    "grids-and-collages/bento-memory-card/1": "image-effects/bento-memory-card@1.0.0"
});
const HISTORICAL_IMAGE_EFFECTS_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    "vintage-film": "image-effects/vintage-film-editorial@1.0.0",
    "premium-studio": "image-effects/premium-studio-product@1.0.0",
    "white-product": "image-effects/white-background-product@1.0.0",
    "lifestyle-scene": "image-effects/lifestyle-product-scene@1.0.0",
    "packaging": "image-effects/packaging-showcase@1.0.0",
    "recipe-flow": "image-effects/recipe-process-flowchart@1.0.0",
    "step-infographic": "image-effects/step-by-step-infographic@1.0.0",
    "hand-drawn-info": "image-effects/hand-drawn-infographic@1.0.0",
    "bento-grid": "image-effects/bento-grid-infographic@1.0.0",
    "tvc-storyboard": "image-effects/product-tvc-storyboard@1.0.0",
    "cinematic-storyboard": "image-effects/cinematic-storyboard@1.0.0",
    "mixed-styles": "image-effects/mixed-style-multi-panel@1.0.0",
    "brand-poster": "image-effects/brand-poster@1.0.0",
    "campaign-kv": "image-effects/campaign-kv@1.0.0",
    "web-hero": "image-effects/banner-hero@1.0.0",
    "editorial-cover": "image-effects/editorial-cover@1.0.0",
    "vintage-editorial": "image-effects/vintage-editorial-infographic@1.0.0",
    "food-map": "image-effects/food-map@1.0.0",
    "lookbook-grid": "image-effects/lookbook-grid@1.0.0",
    "banner-grid": "image-effects/banner-grid-2x2@1.0.0",
    "retro-icons": "image-effects/retro-skeuomorphic-icons@1.0.0",
    "reference-tiramisu/vintage-film-cafe/1": "image-effects/vintage-film-editorial@1.0.0",
    "reference-tiramisu/premium-studio-food/1": "image-effects/premium-studio-product@1.0.0",
    "reference-tiramisu/white-product/1": "image-effects/white-background-product@1.0.0",
    "reference-tiramisu/lifestyle-product-scene/1": "image-effects/lifestyle-product-scene@1.0.0",
    "reference-tiramisu/packaging-showcase/1": "image-effects/packaging-showcase@1.0.0",
    "reference-tiramisu/recipe-flowchart/1": "image-effects/recipe-process-flowchart@1.0.0",
    "reference-tiramisu/step-by-step-infographic/1": "image-effects/step-by-step-infographic@1.0.0",
    "reference-tiramisu/hand-drawn-infographic/1": "image-effects/hand-drawn-infographic@1.0.0",
    "reference-tiramisu/bento-grid/1": "image-effects/bento-grid-infographic@1.0.0",
    "reference-tiramisu/product-tvc-storyboard/1": "image-effects/product-tvc-storyboard@1.0.0",
    "reference-tiramisu/cinematic-storyboard/1": "image-effects/cinematic-storyboard@1.0.0",
    "reference-tiramisu/mixed-style-collage/1": "image-effects/mixed-style-multi-panel@1.0.0",
    "reference-tiramisu/brand-poster/1": "image-effects/brand-poster@1.0.0",
    "reference-tiramisu/campaign-kv-system/1": "image-effects/campaign-kv@1.0.0",
    "reference-tiramisu/banner-hero/1": "image-effects/banner-hero@1.0.0",
    "reference-tiramisu/editorial-cover/1": "image-effects/editorial-cover@1.0.0",
    "reference-tiramisu/vintage-editorial-infographic/1": "image-effects/vintage-editorial-infographic@1.0.0",
    "reference-tiramisu/food-map/1": "image-effects/food-map@1.0.0",
    "reference-tiramisu/lookbook-grid/1": "image-effects/lookbook-grid@1.0.0",
    "reference-tiramisu/banner-grid-2x2/1": "image-effects/banner-grid-2x2@1.0.0",
    "reference-tiramisu/retro-icons/1": "image-effects/retro-skeuomorphic-icons@1.0.0",
    "reference-dog/healing-watercolor/1": "image-effects/healing-scene@1.0.0",
    "reference-dog/kawaii-3d-icon/1": "image-effects/themed-3d-icon@1.0.0",
    "reference-dog/picture-book-scene/1": "image-effects/picture-book-scene@1.0.0",
    "reference-dog/minimalist-mood-poster/1": "image-effects/minimalist-mood-scene@1.0.0",
    "reference-dog/cinematic-concept-scene/1": "image-effects/concept-scene@1.0.0",
    "reference-dog/sticker-set/1": "image-effects/sticker-set@1.0.0",
    "reference-dog/expression-grid/1": "image-effects/character-grid-portrait@1.0.0",
    "reference-dog/character-sheet/1": "image-effects/character-sheet@1.0.0",
    "reference-dog/four-panel-comic/1": "image-effects/four-panel-comic@1.0.0",
    "reference-dog/manga-spread-page/1": "image-effects/manga-spread-page@1.0.0",
    "reference-dog/anime-key-visual/1": "image-effects/anime-key-visual@1.0.0",
    "reference-dog/cinematic-storyboard/1": "image-effects/cinematic-storyboard@1.0.0",
    "reference-dog/mixed-style-collage/1": "image-effects/mixed-style-multi-panel@1.0.0",
    "reference-dog/mascot-brand-kit/1": "image-effects/mascot-brand-kit@1.0.0",
    "reference-dog/character-merch-board/1": "image-effects/character-merch-board@1.0.0",
    "reference-dog/editorial-cover/1": "image-effects/editorial-cover@1.0.0",
    "reference-dog/brand-poster/1": "image-effects/brand-poster@1.0.0",
    "reference-dog/campaign-kv-system/1": "image-effects/campaign-kv@1.0.0",
    "reference-dog/banner-hero/1": "image-effects/banner-hero@1.0.0",
    "reference-dog/retro-icons/1": "image-effects/retro-skeuomorphic-icons@1.0.0",
    "reference-dog/bento-memory-card/1": "image-effects/bento-memory-card@1.0.0"
});
const CANONICAL_STYLE_IDS = new Set(snapshot.effects.map((effect) => `image-effects/${effect.ref}`));

export function resolveImageEffectsStyleId(styleId: string): string | undefined {
    if (CANONICAL_STYLE_IDS.has(styleId)) return styleId;
    const normalized = styleId.startsWith('oba-tiramisu/')
        ? styleId.replace('oba-tiramisu/', 'reference-tiramisu/')
        : styleId.startsWith('oba-dog/')
            ? styleId.replace('oba-dog/', 'reference-dog/')
            : styleId;
    return IMAGE_EFFECTS_LEGACY_ALIASES[normalized] ?? HISTORICAL_IMAGE_EFFECTS_ALIASES[normalized];
}

export const IMAGE_EFFECTS_STYLE_PRESETS: ImageAgentStylePreset[] = snapshot.effects.map((effect) => {
    const category = CATEGORY_META[effect.category];
    if (!category) throw new Error(`Missing image-effects category metadata for ${effect.category}`);
    return {
        id: `image-effects/${effect.ref}`,
        title: effect.title.zh,
        categoryId: effect.category,
        categoryLabel: category.label,
        categoryAccent: category.accent,
        templateRef: `image-effects/${effect.ref}`,
        templateLabel: effect.title.en,
        promptHint: effect.summary.zh,
        promptContent: effect.promptContent,
        promptPath: `references/effects/${effect.id}.md`,
        sourceCaseId: effect.ref,
        sourceRepository: snapshot.sourceRepository,
        sourceRevision: snapshot.catalogDigest,
        sourceLicenseNotice: `Pinned image-effects catalog ${snapshot.catalogVersion} with per-effect provenance in imageEffectsCatalogSnapshot.json.`,
        executionKind: 'gpt-image-2',
        inputMode: effect.input.mode === 'image' ? 'image-required' : 'text-or-image',
        multiInputMode: 'single',
        continuationSourceMode: effect.input.mode === 'image' ? 'original-upload' : undefined,
        supportedInputFormats: ['jpeg', 'png'],
    };
});

const COUNTS = IMAGE_EFFECTS_STYLE_PRESETS.reduce((counts, style) => {
    counts.set(style.categoryId, (counts.get(style.categoryId) ?? 0) + 1);
    return counts;
}, new Map<string, number>());

export const IMAGE_EFFECTS_STYLE_CATEGORIES: ImageAgentStyleCategory[] = Object.entries(CATEGORY_META)
    .map(([id, category]) => ({ id, ...category, count: COUNTS.get(id) ?? 0 }))
    .filter((category) => category.count > 0);
