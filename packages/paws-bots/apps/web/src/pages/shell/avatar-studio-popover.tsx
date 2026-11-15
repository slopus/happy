import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import { resolveBotAvatarSet } from "@rakazo/contracts";
import {
  botLookState,
  botLookWithColor,
  botLookWithShape,
  SHIPPED_BOT_AVATAR_SHAPE_KEYS,
} from "@rakazo/core";
import {
  BOT_COLORS,
  BotAvatar,
  BotShapePreview,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  defaultBotAvatarValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { Button } from "@rakazo/ui-web/components/ui/button";
import { Check, Pencil, Upload, X } from "lucide-react";
import type { ClipboardEvent, DragEvent } from "react";
import { useRef, useState } from "react";

/**
 * The shape grid and color row for a bot's look. With `organicIdentities`, the grid also offers
 * the organic body each identity draws (for a bot that has no id yet); without them, "Default"
 * restores the bot's own organic body.
 */
export function BotLookPicker({
  value,
  identity,
  organicIdentities,
  avatarSet = "organic",
  onAvatarSetChange,
  onChange,
}: {
  value: string;
  identity?: string;
  organicIdentities?: readonly string[];
  avatarSet?: BotAvatarSet;
  onAvatarSetChange?: (set: BotAvatarSet, value: string) => void;
  onChange: (value: string, identity?: string) => void;
}) {
  const {
    photo,
    shapeIndex,
    color: currentColor,
    defaultLook: isDefaultLook,
  } = botLookState(value);

  return (
    <div className="space-y-4">
      {/* Only one bot's own editor overrides the account's set; a new bot takes the default. */}
      {onAvatarSetChange ? (
        <Tabs
          value={avatarSet}
          onValueChange={(next) =>
            onAvatarSetChange(resolveBotAvatarSet(next), defaultBotAvatarValue(value))
          }
        >
          <TabsList className="w-full" aria-label={t`Icon set`}>
            <TabsTrigger value="organic" className="flex-1">
              <Trans>Original</Trans>
            </TabsTrigger>
            <TabsTrigger value="rakazo" className="flex-1">
              <Trans>Rakazo</Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      {avatarSet === "organic" ? (
        <div>
          {organicIdentities ? null : (
            <div className="mb-2 flex items-center justify-between">
              <div className="text-caption font-medium tracking-wider text-muted-foreground uppercase">
                <Trans>Shape</Trans>
              </div>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                data-testid="avatar-studio-default"
                aria-pressed={isDefaultLook}
                onClick={() => {
                  const next = defaultBotAvatarValue(value);
                  if (next !== value) onChange(next);
                }}
                className={`px-3 py-1 text-label font-medium transition-colors ${
                  isDefaultLook
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Trans>Default</Trans>
              </Button>
            </div>
          )}
          <div
            className={`grid place-items-center gap-2 ${organicIdentities ? "grid-cols-4 sm:grid-cols-8 sm:gap-1" : "grid-cols-4"}`}
          >
            {organicIdentities?.map((organicIdentity, index) => (
              <BotShapePreview
                key={organicIdentity}
                identity={organicIdentity}
                label={t`Shape ${index + 1}`}
                color={currentColor}
                selected={isDefaultLook && identity === organicIdentity}
                onClick={() => onChange(currentColor, organicIdentity)}
              />
            ))}
            {SHIPPED_BOT_AVATAR_SHAPE_KEYS.map((key, index) => (
              <BotShapePreview
                key={key}
                shapeIndex={index}
                color={currentColor}
                selected={shapeIndex === index}
                onClick={() => onChange(botLookWithShape(currentColor, index))}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div>
        {organicIdentities ? null : (
          <div className="mb-2 text-caption font-medium tracking-wider text-muted-foreground uppercase">
            <Trans>Color</Trans>
          </div>
        )}
        <div className="grid grid-cols-6 place-items-center gap-2">
          {BOT_COLORS.map((color) => {
            const selected = currentColor.toLowerCase() === color.toLowerCase() && !photo;
            return (
              <button
                key={color}
                type="button"
                onClick={() => onChange(botLookWithColor(value, color))}
                aria-label={t`Color ${color}`}
                aria-pressed={selected}
                className={`size-6 rounded-full border transition-transform hover:scale-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "scale-105 border-transparent ring-2 ring-foreground ring-offset-2 ring-offset-popover"
                    : "border-border"
                }`}
                style={{ backgroundColor: color }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export interface AvatarStudioPopoverProps {
  value: string;
  identity?: string;
  status?: string;
  avatarSet?: BotAvatarSet;
  size?: number;
  onChange: (value: string, avatarSet?: BotAvatarSet) => void;
  disabled?: boolean;
}

export function AvatarStudioPopover({
  value,
  identity,
  status,
  avatarSet = "organic",
  size = 72,
  onChange,
  disabled = false,
}: AvatarStudioPopoverProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"bot" | "upload">("bot");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function restoreDefaultAvatar() {
    const next = defaultBotAvatarValue(value);
    if (next !== value) onChange(next);
  }

  function processImageFile(file: File) {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const src = event.target?.result as string;
      if (!src) return;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const targetSize = 256;
        canvas.width = targetSize;
        canvas.height = targetSize;
        if (!ctx) return;

        ctx.beginPath();
        ctx.arc(targetSize / 2, targetSize / 2, targetSize / 2, 0, Math.PI * 2);
        ctx.clip();

        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, targetSize, targetSize);

        onChange(canvas.toDataURL("image/webp", 0.9));
        setOpen(false);
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) processImageFile(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLButtonElement>) {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item?.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) {
        processImageFile(file);
        break;
      }
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="group relative cursor-pointer rounded-2xl outline-none transition-transform hover:scale-[1.03] focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t`Customize bot avatar`}
        data-testid="avatar-studio-trigger"
      >
        <BotAvatar
          color={value}
          identity={identity}
          size={size}
          status={status}
          avatarSet={avatarSet}
        />
        <div className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border-2 border-background bg-secondary text-foreground shadow-md opacity-0 transition group-hover:scale-110 group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
          <Pencil size={12} strokeWidth={2.2} />
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[360px] max-w-full gap-4 rounded-3xl p-5 sm:max-w-[360px]"
          data-testid="avatar-studio"
        >
          <DialogHeader className="flex-row items-center justify-between space-y-0">
            <DialogTitle className="text-body font-semibold tracking-tight">
              <Trans>Avatar Studio</Trans>
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Choose a bot shape, color, or upload an image</Trans>
            </DialogDescription>
            <Button
              variant="ghost"
              size="icon-sm"
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full text-muted-foreground"
              aria-label={t`Close`}
            >
              <X size={16} />
            </Button>
          </DialogHeader>

          <div className="flex flex-col items-center justify-center py-2">
            <BotAvatar
              color={value}
              identity={identity}
              size={78}
              status={status}
              avatarSet={avatarSet}
            />
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(next) => setActiveTab(next as "bot" | "upload")}
            className="gap-4"
          >
            <div className="flex items-center justify-between border-b border-border pb-1">
              <TabsList className="rounded-full">
                <TabsTrigger value="bot" className="rounded-full px-3 text-label">
                  <Trans>Bot</Trans>
                </TabsTrigger>
                <TabsTrigger value="upload" className="rounded-full px-3 text-label">
                  <Trans>Upload</Trans>
                </TabsTrigger>
              </TabsList>

              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={restoreDefaultAvatar}
                className="text-label text-muted-foreground"
              >
                <Trans>Reset</Trans>
              </Button>
            </div>

            <TabsContent value="bot" className="pt-1" data-testid="avatar-studio-bot-tab">
              <BotLookPicker
                value={value}
                identity={identity}
                avatarSet={avatarSet}
                onChange={(next) => onChange(next)}
                onAvatarSetChange={(set, next) => onChange(next, set)}
              />
            </TabsContent>
            <TabsContent value="upload">
              <button
                type="button"
                aria-label={t`Image upload area`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onPaste={handlePaste}
                onClick={() => fileInputRef.current?.click()}
                className={`flex w-full flex-col items-center justify-center rounded-xl border border-dashed p-6 text-center transition-colors ${
                  dragOver
                    ? "border-primary bg-primary/10"
                    : "border-border bg-muted hover:border-foreground/30"
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) processImageFile(file);
                  }}
                />
                <div className="mb-2 grid size-10 place-items-center rounded-full bg-secondary text-muted-foreground">
                  <Upload size={18} strokeWidth={1.8} />
                </div>
                <p className="text-body-sm font-medium text-muted-foreground">
                  <Trans>Drag, drop, or paste an image</Trans>
                </p>
                <span className="mt-3 rounded-lg bg-secondary px-3 py-1.5 text-label font-medium text-foreground">
                  <Trans>Choose file</Trans>
                </span>
              </button>
            </TabsContent>
          </Tabs>

          <DialogFooter className="border-border sm:justify-end">
            <Button variant="secondary" size="sm" type="button" onClick={() => setOpen(false)}>
              <Check size={14} />
              <Trans>Done</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
