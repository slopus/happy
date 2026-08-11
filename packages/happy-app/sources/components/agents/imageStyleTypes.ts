export interface ImageAgentStyleCategory {
    id: string;
    label: string;
    labelKey?: ImageAgentStyleLabelKey;
    accent: string;
    count: number;
}

export interface ImageAgentStylePreset {
    id: string;
    title: string;
    labelKey?: ImageAgentStyleLabelKey;
    categoryId: string;
    categoryLabel: string;
    categoryLabelKey?: ImageAgentStyleLabelKey;
    categoryAccent: string;
    templateRef: string;
    templateLabel: string;
    templateLabelKey?: ImageAgentStyleLabelKey;
    promptHint: string;
    promptHintKey?: ImageAgentStyleLabelKey;
    promptContent: string;
    promptPath: string;
    sourceCaseId: string;
    sourceRepository: string;
    sourceRevision?: string;
    sourceLicenseNotice?: string;
    executionKind?: 'gpt-image-2' | 'deterministic-grade';
    inputMode?: 'text-or-image' | 'image-required';
    multiInputMode?: 'single' | 'batch';
    continuationSourceMode?: 'original-upload' | 'latest-result';
    supportedInputFormats?: Array<'jpeg' | 'png'>;
    responseInstructions?: string;
    referenceImages?: ImageAgentStyleReferenceImage[];
    analysisStatus?: UserImageStyleAnalysisStatus;
    analysisError?: string;
    customPromptContent?: string;
    customNegativePrompt?: string;
    customCreatedAt?: number;
    customUpdatedAt?: number;
    customAnalyzedAt?: number;
    customAnalysisSessionId?: string;
    custom?: boolean;
}

export interface ImageAgentStyleReferenceImage {
    id: string;
    uri: string;
    width: number;
    height: number;
    mimeType: string;
    size: number;
    name: string;
    thumbhash?: string;
}

export interface UserImageStyle {
    id: string;
    title: string;
    promptHint: string;
    promptContent?: string;
    negativePrompt?: string;
    tags: string[];
    analysisStatus: UserImageStyleAnalysisStatus;
    analysisError?: string;
    analysisSessionId?: string;
    analyzedAt?: number;
    promptSource: UserImageStylePromptSource;
    referenceImages: ImageAgentStyleReferenceImage[];
    createdAt: number;
    updatedAt: number;
}

export type UserImageStyleAnalysisStatus = 'reference-ready' | 'analyzing' | 'prompt-ready' | 'failed';

export type UserImageStylePromptSource = 'reference-image' | 'extracted-prompt' | 'manual';

export type ImageAgentStyleLabelKey =
    | 'agents.imageStyleGithubSkills'
    | 'agents.imageStyleMinimalZinePoster'
    | 'agents.imageStyleMinimalZinePosterHint'
    | 'agents.imageStyleSceneDistillationZine'
    | 'agents.imageStyleSceneDistillationZineHint'
    | 'agents.imageStyleGradeImages'
    | 'agents.imageStyleGradeImagesHint'
    | 'agents.imageStyleScenesGatheredZine'
    | 'agents.imageStyleScenesGatheredZineHint'
    | 'agents.imageStyleScenesGatheredZineSea'
    | 'agents.imageStyleScenesGatheredZineSeaHint'
    | 'agents.imageStylePhotoIllustrationDiptych'
    | 'agents.imageStylePhotoIllustrationDiptychHint'
    | 'agents.imageStylePhotoIllustrationDiptychLakeside'
    | 'agents.imageStylePhotoIllustrationDiptychLakesideHint'
    | 'agents.imageStylePhotoIllustrationEditorialEcho'
    | 'agents.imageStylePhotoIllustrationEditorialEchoHint'
    | 'agents.imageStyleVintageFilm'
    | 'agents.imageStylePremiumStudio'
    | 'agents.imageStyleWhiteProduct'
    | 'agents.imageStyleLifestyleScene'
    | 'agents.imageStylePackaging'
    | 'agents.imageStyleRecipeFlow'
    | 'agents.imageStyleStepInfographic'
    | 'agents.imageStyleHandDrawnInfo'
    | 'agents.imageStyleBentoGrid'
    | 'agents.imageStyleTvcStoryboard'
    | 'agents.imageStyleCinematicStoryboard'
    | 'agents.imageStyleMixedStyles'
    | 'agents.imageStyleBrandPoster'
    | 'agents.imageStyleCampaignKv'
    | 'agents.imageStyleWebHero'
    | 'agents.imageStyleEditorialCover'
    | 'agents.imageStyleVintageEditorial'
    | 'agents.imageStyleFoodMap'
    | 'agents.imageStyleLookbookGrid'
    | 'agents.imageStyleBannerGrid'
    | 'agents.imageStyleRetroIcons';
