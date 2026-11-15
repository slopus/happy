import { Trans, useLingui } from "@lingui/react/macro";
import { BOT_COLOR_LIST, signInProviders } from "@rakazo/contracts";
import {
  credentialIssue,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  signupRequiresEmailVerification,
  suggestEmailCorrection,
} from "@rakazo/core";
import {
  Button,
  Input,
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
  Label,
  LogoAvatar,
} from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PasskeySignIn, usePasskeySignIn } from "../components/PasskeySignIn";
import { SocialSignInButtons } from "../components/SocialSignInButtons";
import { authClient } from "../lib/auth";
import type { AuthCapabilities } from "../lib/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { desktopBridge } from "../lib/desktop";
import { clearSpaceSelection } from "../lib/rpc";
import { newAccountDestination, signInNext } from "../lib/sign-in-next";
import { runSsoFlow } from "../lib/sso-flow";
import { authErrorText, credentialIssueText } from "../lib/user-error";
import { WindowChrome } from "./WindowChrome";

type AuthMode = "in" | "up" | "forgot";

// off-scale: 16px below md stops iOS Safari zooming into a focused field.
const fieldClass = "mt-2 h-12 rounded-xl px-4 text-[16px]/6 md:text-body-lg";
const CODE_LENGTH = 6;
export const submitClass = "mt-3 h-12 w-full rounded-xl text-body-lg";

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useLingui();
  const [searchParams, setSearchParams] = useSearchParams();
  const next = signInNext(searchParams.get("next"));
  // Switching between sign-in and sign-up keeps where the person was going.
  const nextQuery = next ? `?next=${encodeURIComponent(next)}` : "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [emailBlurred, setEmailBlurred] = useState(false);
  const [warnedEmail, setWarnedEmail] = useState<string | null>(null);
  const emailSuggestion = mode === "up" ? suggestEmailCorrection(email) : null;
  const [error, setError] = useState<string | null>(() => {
    const code = searchParams.get("error");
    if (!code) return null;
    return authErrorText({ code }, t`Could not continue`);
  });
  const [pending, setPending] = useState(false);
  const entering = useRef(false);
  const passkey = usePasskeySignIn({ onSignedIn: enterApp, onError: setError });
  const [resetSent, setResetSent] = useState(false);
  // Signup triggers a session refresh that remounts the anonymous auth page.
  const sent = resetSent || searchParams.get("verify") === "email";
  const [reset, setReset] = useState<AuthCapabilities | null>(null);
  const [capabilityError, setCapabilityError] = useState(false);
  const [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [emailStep, setEmailStep] = useState(false);
  const useCode = Boolean(reset?.passwordAuth && reset.emailCode) && mode !== "forgot";
  // A blank password asks for an emailed code, so code-only accounts need no toggle.
  const codeMode = useCode && !password;
  const codeStep = useCode && codeSent;
  const providers = reset ? signInProviders(reset) : [];
  const chooser = Boolean(
    reset?.passwordAuth && providers.length > 0 && !emailStep && mode !== "forgot" && !codeStep,
  );
  // The chooser and the email step share a card. A server with no providers keeps today's form.
  const presented = Boolean(
    reset?.passwordAuth && providers.length > 0 && mode !== "forgot" && !sent && !codeStep,
  );
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
  const title =
    sent || codeStep ? (
      <Trans>Check your email</Trans>
    ) : presented && mode === "in" ? (
      <Trans>Welcome back</Trans>
    ) : mode === "in" ? (
      <Trans>Sign in to Rakazo</Trans>
    ) : mode === "up" ? (
      <Trans>Create your Rakazo</Trans>
    ) : (
      <Trans>Reset your password</Trans>
    );

  useEffect(() => {
    setEmailStep(false);
  }, [mode]);

  useEffect(() => {
    setReset(null);
    setCapabilityError(false);
    let active = true;
    void fetchAuthCapabilities()
      .then((capabilities) => {
        if (active) setReset(capabilities);
      })
      .catch(() => {
        if (active) setCapabilityError(true);
      });
    return () => {
      // Do not abort on unmount: a guard redirect that bounces through this
      // page only mounts it for a render or two, and the cancelled fetch then
      // surfaces as a failed request. `active` drops the result; the request
      // keeps its own time bound.
      active = false;
    };
  }, [mode, capabilityAttempt]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!reset?.passwordAuth) return;
    if (codeStep) {
      // An unfinished code would spend one of the code's three attempts.
      if (code.length === CODE_LENGTH) await verifyCode(code);
      return;
    }
    const issue = credentialIssue({
      email,
      password: mode === "forgot" || codeMode ? undefined : password,
    });
    if (issue) {
      setError(credentialIssueText(issue));
      return;
    }
    if (emailSuggestion && warnedEmail !== email) {
      setWarnedEmail(email);
      setEmailBlurred(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!reset?.passwordReset || !reset.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: reset.resetUrl,
        });
        if (result.error) {
          setError(authErrorText(result.error, t`Could not send reset email`));
          return;
        }
        setResetSent(true);
        return;
      }
      const trimmedEmail = email.trim();
      if (codeMode) {
        const request = await authClient.emailOtp.sendVerificationOtp({
          email: trimmedEmail,
          type: "sign-in",
        });
        if (request.error) {
          setError(authErrorText(request.error, t`Could not continue`));
          return;
        }
        setCode("");
        setCodeSent(true);
        return;
      }
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email: trimmedEmail,
              password,
              name: name || trimmedEmail.split("@")[0] || "User",
            })
          : await authClient.signIn.email({ email: trimmedEmail, password });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not continue`));
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        setSearchParams({ verify: "email", ...(next ? { next } : {}) });
        return;
      }
      enterApp();
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  async function verifyCode(otp: string) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const trimmedEmail = email.trim();
      const result = await authClient.signIn.emailOtp({
        email: trimmedEmail,
        otp,
        // Only used when this creates the account.
        name: mode === "up" ? name || trimmedEmail.split("@")[0] || "User" : undefined,
      });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not continue`));
        setCode("");
        return;
      }
      enterApp();
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      if (!entering.current) setPending(false);
    }
  }

  function enterApp() {
    clearSpaceSelection();
    // The routes move a signed-in user on once the session refetch lands. Navigating
    // first beats it, so the guards bounce through sign-in and the shell.
    entering.current = true;
    setPending(true);
  }

  function leaveCodeStep() {
    setCodeSent(false);
    setCode("");
    setError(null);
  }

  async function signInWithProvider(provider: string) {
    setError(null);
    try {
      const result = await runSsoFlow(
        (disableRedirect, callbackURL) =>
          authClient.signIn.social({
            disableRedirect,
            provider,
            newUserCallbackURL: callbackURL(newAccountDestination(next)),
            callbackURL: callbackURL(next ?? "/app"),
            errorCallbackURL: callbackURL("/sign-in"),
          }),
        ["/app", "/onboarding", "/integrations/setup", "/sign-in", ...(next ? [next] : [])],
      );
      if (result.error) setError(authErrorText(result.error, t`Could not continue`));
    } catch {
      setError(t`Could not continue`);
    }
  }

  if (!sent && !reset && !capabilityError) {
    return <div className="h-full bg-background" />;
  }

  return (
    <AuthFrame
      onSubmit={submit}
      title={title}
      surface={presented}
      leading={
        presented && emailStep ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              setError(null);
              setEmailStep(false);
            }}
          >
            <ChevronLeft />
            <Trans>Back</Trans>
          </Button>
        ) : null
      }
    >
      {sent ? (
        <div className="w-full text-center">
          <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          {capabilityError ? (
            <div role="alert" className="w-full text-center">
              <p>
                <Trans>Could not load sign-in options</Trans>
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}
              >
                <Trans>Retry</Trans>
              </Button>
            </div>
          ) : null}
          {!reset?.passwordAuth && mode !== "forgot" ? (
            <SocialSignInButtons
              providers={providers}
              disabled={pending}
              onPress={(providerId) => void signInWithProvider(providerId)}
            />
          ) : null}
          {error && !reset?.passwordAuth ? (
            <p
              role="alert"
              className="mx-auto mt-4 w-full max-w-sm text-center text-body-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          {chooser ? (
            <>
              <SocialSignInButtons
                providers={providers}
                disabled={pending || passkey.pending}
                onPress={(providerId) => void signInWithProvider(providerId)}
                onEmail={() => {
                  setError(null);
                  setEmailStep(true);
                }}
                onPasskey={mode === "in" && passkey.supported ? passkey.start : undefined}
              />
              {error ? (
                <p
                  role="alert"
                  className="mx-auto mt-4 w-full max-w-sm text-center text-body-sm text-destructive"
                >
                  {error}
                </p>
              ) : null}
              <p className="mt-8 text-center text-muted-foreground">
                {mode === "in" ? (
                  <>
                    <Trans>Don’t have an account?</Trans>{" "}
                    <Link to={`/sign-up${nextQuery}`} className="font-medium text-foreground">
                      <Trans>Sign up</Trans>
                    </Link>
                  </>
                ) : (
                  <>
                    <Trans>Already have an account?</Trans>{" "}
                    <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
                      <Trans>Sign in</Trans>
                    </Link>
                  </>
                )}
              </p>
            </>
          ) : null}
          {reset?.passwordAuth && !chooser ? (
            <>
              {mode === "up" && !codeStep ? (
                <div className="mb-4 w-full">
                  <Label htmlFor="name" className="text-muted-foreground">
                    <Trans>Name</Trans>
                  </Label>
                  <Input
                    id="name"
                    name="name"
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t`Your name`}
                    className={fieldClass}
                  />
                </div>
              ) : null}
              {codeStep ? (
                <div className="flex w-full justify-center">
                  <InputOTP
                    aria-label={t({ message: "Code", context: "email sign-in" })}
                    maxLength={CODE_LENGTH}
                    pattern={"^\\d+$"}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    value={code}
                    onChange={setCode}
                    onComplete={(value: string) => void verifyCode(value)}
                  >
                    <InputOTPGroup>
                      {[0, 1, 2, 3, 4, 5].map((index) => (
                        <InputOTPSlot
                          key={index}
                          index={index}
                          className="size-12 text-heading3 first:rounded-l-xl last:rounded-r-xl"
                        />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
              ) : (
                <div className="w-full">
                  <Label htmlFor="email" className="text-muted-foreground">
                    <Trans>Email</Trans>
                  </Label>
                  <Input
                    id="email"
                    name="email"
                    autoComplete={mode === "in" ? "username webauthn" : "username"}
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setEmailBlurred(false);
                    }}
                    onBlur={() => setEmailBlurred(true)}
                    placeholder={t`Your email address`}
                    type="email"
                    required
                    className={fieldClass}
                  />
                  {emailSuggestion && emailBlurred ? (
                    <p role="status" className="mt-2 text-body text-warning">
                      <Trans>
                        Did you mean{" "}
                        <button
                          type="button"
                          className="font-medium underline"
                          onClick={() => setEmail(emailSuggestion)}
                        >
                          {emailSuggestion}
                        </button>
                        ?
                      </Trans>
                    </p>
                  ) : null}
                </div>
              )}
              {mode !== "forgot" && !codeStep ? (
                <div className="mt-4 w-full">
                  <Label htmlFor={passwordFieldId} className="text-muted-foreground">
                    <Trans>Password</Trans>
                  </Label>
                  <Input
                    id={passwordFieldId}
                    name="password"
                    autoComplete={mode === "in" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t`Password`}
                    type="password"
                    required={!useCode}
                    minLength={mode === "up" ? MIN_PASSWORD_LENGTH : undefined}
                    maxLength={MAX_PASSWORD_LENGTH}
                    className={fieldClass}
                  />
                  {mode === "in" && reset?.passwordReset ? (
                    <div className="mt-2 text-right text-body">
                      <Link to="/forgot-password" className="font-medium text-foreground">
                        <Trans>Forgot password?</Trans>
                      </Link>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {error ? (
                <p role="alert" className="mt-3 w-full text-body text-destructive">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                size="lg"
                disabled={pending || (codeStep && code.length < CODE_LENGTH)}
                className={submitClass}
              >
                {pending ? (
                  <Trans>Working…</Trans>
                ) : codeMode ? (
                  <Trans>Continue</Trans>
                ) : mode === "in" ? (
                  <Trans>Sign in</Trans>
                ) : mode === "forgot" ? (
                  <Trans>Send reset link</Trans>
                ) : (
                  <Trans>Create account</Trans>
                )}
              </Button>
              {mode === "in" && !codeStep ? (
                <PasskeySignIn
                  autoFillOnly={presented}
                  disabled={pending}
                  className={submitClass}
                  onSignedIn={enterApp}
                  onError={setError}
                />
              ) : null}
              {codeStep ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  disabled={pending}
                  className="mt-3 text-muted-foreground"
                  onClick={leaveCodeStep}
                >
                  <Trans>Back</Trans>
                </Button>
              ) : null}
              {codeStep ? null : (
                <p className="mt-8 text-center text-muted-foreground">
                  {mode === "in" ? (
                    <>
                      <Trans>Don’t have an account?</Trans>{" "}
                      <Link to={`/sign-up${nextQuery}`} className="font-medium text-foreground">
                        <Trans>Sign up</Trans>
                      </Link>
                    </>
                  ) : mode === "up" ? (
                    <>
                      <Trans>Already have an account?</Trans>{" "}
                      <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
                        <Trans>Sign in</Trans>
                      </Link>
                    </>
                  ) : (
                    <Link to={`/sign-in${nextQuery}`} className="font-medium text-foreground">
                      <Trans>Back to sign in</Trans>
                    </Link>
                  )}
                </p>
              )}
            </>
          ) : null}
        </>
      )}
    </AuthFrame>
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(authErrorText(result.error, t`Could not reset password`));
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-heading3">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-body text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </AuthFrame>
  );
}

export function AuthFrame({
  title,
  surface = false,
  leading,
  onSubmit,
  children,
}: {
  title: React.ReactNode;
  surface?: boolean;
  leading?: React.ReactNode;
  onSubmit: (event: React.FormEvent) => void;
  children: React.ReactNode;
}) {
  const server = desktopBridge()?.server;
  return (
    <div
      className="flex min-h-full flex-col bg-background text-foreground"
      data-rakazo-surface="auth"
    >
      <div className="app-drag flex items-center gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <div className="flex flex-1 items-center justify-center px-6 pb-16">
        <form
          onSubmit={onSubmit}
          className={
            surface
              ? "flex w-full max-w-[520px] flex-col rounded-3xl border border-border bg-card px-8 pt-8 pb-9 shadow-sm"
              : "flex w-full max-w-[460px] flex-col items-center"
          }
        >
          {leading ? <div className="mb-4 self-start">{leading}</div> : null}
          <div className={surface ? "flex w-full flex-col items-center" : "contents"}>
            <LogoAvatar
              size={74}
              avatarValue={BOT_COLOR_LIST.find((color) => color.id === "orange")?.hex}
              motion={false}
            />
            <h1
              aria-live="polite"
              className={
                surface
                  ? "mt-5 mb-6 text-balance text-center text-display font-medium tracking-tight"
                  : "mt-7 mb-9 text-balance text-center text-display font-medium tracking-tight"
              }
            >
              {title}
            </h1>
          </div>
          {children}
        </form>
      </div>
      {server ? (
        <div className="flex justify-center pb-6">
          <Button type="button" variant="text" size="sm" onClick={() => void server.change()}>
            <Trans>Change server</Trans>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={MIN_PASSWORD_LENGTH}
        maxLength={MAX_PASSWORD_LENGTH}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
