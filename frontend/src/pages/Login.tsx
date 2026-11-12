import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { Loader2, Mail, Lock, Sparkles, UserPlus, Eye, EyeOff } from 'lucide-react';
import sothLogo from '@/assets/SOTH_Logo.png';

interface LoginPageError extends Error {
  locked?: boolean;
  locked_until?: string;
}

const isLoginPageError = (error: unknown): error is LoginPageError => error instanceof Error;

export default function Login() {
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(0);
  const { login, completeAdminPinLogin, requestAdminPinReset } = useAuth();
  const [pinChallenge, setPinChallenge] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [pinRequestSent, setPinRequestSent] = useState(false);
  const [requestingPinReset, setRequestingPinReset] = useState(false);
  const [shakePin, setShakePin] = useState(false);

  // Countdown timer for account lockout
  useEffect(() => {
    if (!lockedUntil) return;
    const update = () => {
      const remaining = Math.ceil((lockedUntil.getTime() - Date.now()) / 1000);
      if (remaining <= 0) {
        setLockedUntil(null);
        setCountdown(0);
        setError('');
      } else {
        setCountdown(remaining);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);

  // Check for OAuth error messages in URL
  useEffect(() => {
    const errorParam = searchParams.get('error');
    if (errorParam) {
      switch (errorParam) {
        case 'account_pending':
          setError('⏳ Your account is pending approval. Please contact an administrator to activate your account.');
          break;
        case 'account_suspended':
          setError('🚫 Your account has been suspended. Please contact an administrator.');
          break;
        case 'account_inactive':
          setError('❌ Your account is not active. Please contact support.');
          break;
        default:
          setError('❌ An error occurred during sign in. Please try again.');
      }
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (pinChallenge) {
      if (pin.length !== 4) {
        setPinError('Enter all four PIN digits.');
        return;
      }
      setLoading(true);
      setPinError('');
      try {
        await completeAdminPinLogin(pinChallenge, pin);
      } catch (err: unknown) {
        setPin('');
        setPinError(err instanceof Error ? err.message : 'Incorrect PIN. Please try again.');
        setShakePin(true);
        window.setTimeout(() => setShakePin(false), 450);
      } finally {
        setLoading(false);
      }
      return;
    }

    // Block submission if account is still locked
    if (lockedUntil && lockedUntil > new Date()) {
      return;
    }
    
    // Validation
    if (!email || !password) {
      setError('Please enter both email and password');
      return;
    }

    if (!email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setLoading(true);

    try {
      const result = await login(email, password);
      if (result.requiresPin && result.challengeToken) {
        setPassword('');
        setPinChallenge(result.challengeToken);
        setPin('');
        setPinError('');
      }
    } catch (err: unknown) {
      // Provide specific error messages
      const message = err instanceof Error ? err.message : '';

      if (isLoginPageError(err) && err.locked && err.locked_until) {
        // Per-account lockout with countdown timer
        setLockedUntil(new Date(err.locked_until));
        setError(`🔒 ${message}`);
      } else if (message.includes('locked') || message.includes('Too many failed')) {
        setError(`🔒 ${message}`);
      } else if (message.includes('Incorrect login credentials') || message.includes('Invalid credentials')) {
        setError(`❌ ${message}`);
      } else if (message.includes('rejected')) {
        setError(`❌ ${message}`);
      } else if (message.includes('pending') || message.includes('awaiting approval')) {
        setError(`⏳ ${message}`);
      } else if (message.includes('suspended')) {
        setError(`🚫 ${message}`);
      } else {
        setError(message || '⚠️ Login failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const appendPinDigit = (digit: string) => setPin((current) => current.length < 4 ? current + digit : current);

  const handlePinResetRequest = async () => {
    if (!pinChallenge) return;
    setRequestingPinReset(true);
    setPinError('');
    try {
      const message = await requestAdminPinReset(pinChallenge);
      setPinRequestSent(true);
      setPinError(message);
    } catch (err: unknown) {
      setPinError(err instanceof Error ? err.message : 'Unable to send the PIN removal request.');
    } finally {
      setRequestingPinReset(false);
    }
  };

  return (
    <div 
      className="auth-page-enter relative h-[100dvh] min-h-0 overflow-hidden flex items-center justify-center bg-gradient-to-br from-primary/10 via-background to-secondary/10 p-2 sm:p-4 lg:p-3 overscroll-none"
      style={{ touchAction: 'manipulation' }}
    >
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-20 left-10 w-72 h-72 bg-primary/5 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-20 right-10 w-96 h-96 bg-secondary/5 rounded-full blur-3xl animate-pulse delay-1000"></div>
      </div>

      <div 
        className="w-full max-w-md lg:max-w-sm relative z-10 max-h-full select-none"
        style={{ touchAction: 'manipulation' }}
      >
        {/* Logo and Brand */}
        <div className="text-center mb-3 sm:mb-6 lg:mb-3 animate-in fade-in slide-in-from-top duration-700">
          <div className="inline-flex items-center justify-center w-12 h-12 sm:w-16 sm:h-16 lg:w-14 lg:h-14 rounded-xl sm:rounded-2xl shadow-lg mb-2 sm:mb-3 lg:mb-2 overflow-hidden bg-white dark:bg-neutral-950 border border-border">
            <img
              src={sothLogo}
              alt="Soth Dry Cleaners"
              className="block dark:hidden w-full h-full object-contain p-1"
            />
            <img
              src={sothLogo}
              alt="Soth Dry Cleaners"
              className="hidden dark:block w-full h-full object-contain p-1"
            />
          </div>
          <h1 className="text-2xl sm:text-3xl lg:text-xl font-bold leading-tight text-foreground mb-1">
            Soth Dry Cleaners ERP
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground flex items-center justify-center gap-1.5">
            <Sparkles className="h-3 w-3 flex-shrink-0" />
            <span className="truncate px-2">Soth Dry Cleaners</span>
            <Sparkles className="h-3 w-3 flex-shrink-0" />
          </p>
        </div>

        {/* Login Card */}
        <Card className="shadow-2xl border-2 animate-in fade-in slide-in-from-bottom duration-700 delay-300">
          <CardHeader className="space-y-1 pb-3 sm:pb-4 lg:pb-3">
            <CardTitle className="text-lg sm:text-xl lg:text-lg font-bold text-center">
              {pinChallenge ? 'Administrator PIN' : 'Welcome Back'}
            </CardTitle>
            <CardDescription className="text-center text-xs sm:text-sm">
              {pinChallenge ? 'Enter your four-digit PIN to finish signing in.' : 'Sign in to manage your laundry operations'}
            </CardDescription>
          </CardHeader>
          <CardContent className="px-3 sm:px-6 lg:px-5 pb-4 sm:pb-6 lg:pb-4">
            <form onSubmit={handleSubmit} className="space-y-3 lg:space-y-2.5">
              {error && (
                <Alert variant="destructive" className="animate-in slide-in-from-top py-2">
                  <AlertDescription className="text-xs sm:text-sm break-words">{error}</AlertDescription>
                </Alert>
              )}

              {pinChallenge ? (
                <div className="space-y-4 py-2">
                  <div className="flex justify-center">
                    <div className={shakePin ? 'animate-pin-shake' : ''}>
                      <InputOTP
                        maxLength={4}
                        mask
                        value={pin}
                        onChange={(value) => { setPin(value); setPinError(''); }}
                        pattern={REGEXP_ONLY_DIGITS}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        disabled={loading || requestingPinReset}
                      >
                        <InputOTPGroup>
                          {[0, 1, 2, 3].map((index) => (
                            <InputOTPSlot
                              key={index}
                              index={index}
                              className={`h-12 w-12 text-lg ${pinError && !pinRequestSent ? 'border-destructive text-destructive' : ''}`}
                            />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                    </div>
                  </div>
                  <div className="mx-auto grid w-52 grid-cols-3 gap-2" aria-label="PIN keypad">
                    {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'delete'].map((key) => (
                      <Button
                        key={key}
                        type="button"
                        variant="outline"
                        className="h-11 text-base"
                        disabled={loading || requestingPinReset}
                        aria-label={key === 'delete' ? 'Delete last digit' : key === 'clear' ? 'Clear PIN' : `Enter ${key}`}
                        onClick={() => {
                          if (key === 'delete') setPin((current) => current.slice(0, -1));
                          else if (key === 'clear') setPin('');
                          else appendPinDigit(key);
                          setPinError('');
                        }}
                      >
                        {key === 'delete' ? '⌫' : key === 'clear' ? 'C' : key}
                      </Button>
                    ))}
                  </div>
                  {pinError && (
                    <Alert variant={pinRequestSent ? 'default' : 'destructive'} className="py-2">
                      <AlertDescription className="text-xs sm:text-sm">{pinError}</AlertDescription>
                    </Alert>
                  )}
                  <Button type="submit" className="w-full h-10 font-semibold" disabled={loading || pin.length !== 4}>
                    {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Verifying PIN...</> : 'Verify PIN'}
                  </Button>
                  <div className="flex items-center justify-between text-xs">
                    <button type="button" onClick={() => { setPinChallenge(null); setPin(''); setPinError(''); setPinRequestSent(false); }} className="text-muted-foreground hover:text-foreground hover:underline">
                      Back to sign in
                    </button>
                    <button type="button" onClick={handlePinResetRequest} disabled={requestingPinReset || pinRequestSent} className="text-primary hover:underline disabled:opacity-60">
                      {requestingPinReset ? 'Sending request...' : pinRequestSent ? 'Request sent' : 'Forgot PIN?'}
                    </button>
                  </div>
                  <p className="text-center text-[11px] text-muted-foreground">
                    PIN removal requests are reviewed by the systems administrator. Your PIN stays active until approved.
                  </p>
                </div>
              ) : <>
              <div className="space-y-1.5">
                <Label htmlFor="email" className="text-xs sm:text-sm lg:text-xs">Email Address</Label>
                <div className="relative">
                  <Mail className="absolute left-2.5 sm:left-3 top-2.5 sm:top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    placeholder="your@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="pl-8 sm:pl-10 h-9 sm:h-10 lg:h-9 text-xs sm:text-sm lg:text-xs"
                    required
                    disabled={loading || !!lockedUntil}
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label htmlFor="password" className="text-xs sm:text-sm lg:text-xs">Password</Label>
                  <Link 
                    to="/forgot-password" 
                    className="text-[10px] sm:text-xs text-primary hover:underline"
                  >
                    Forgot?
                  </Link>
                </div>
                <div className="relative">
                  <Lock className="absolute left-2.5 sm:left-3 top-2.5 sm:top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-8 sm:pl-10 pr-9 h-9 sm:h-10 lg:h-9 text-xs sm:text-sm lg:text-xs"
                    required
                    disabled={loading || !!lockedUntil}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 sm:right-3 top-2.5 sm:top-3 text-muted-foreground hover:text-foreground transition-colors"
                    disabled={loading || !!lockedUntil}
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <Button
                type="submit"
                className="w-full h-9 sm:h-10 lg:h-9 text-xs sm:text-sm lg:text-xs font-semibold mt-4"
                disabled={loading || !!lockedUntil}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : lockedUntil ? (
                  `🔒 Locked — try again in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, '0')}`
                ) : (
                  'Sign In'
                )}
              </Button>
              </>}
            </form>

            {/* Sign Up Link */}
            {!pinChallenge && <div className="mt-3 sm:mt-4 lg:mt-3 text-center space-y-1.5 sm:space-y-2 lg:space-y-1.5">
              <Separator />
              <p className="text-[10px] sm:text-xs text-muted-foreground pt-1">
                Don't have an account?
              </p>
              <Link to="/create-account">
                <Button 
                  variant="outline" 
                  className="w-full h-9 sm:h-10 lg:h-9 text-xs sm:text-sm lg:text-xs"
                  disabled={loading}
                >
                  <UserPlus className="mr-1.5 sm:mr-2 h-3.5 w-3.5 sm:h-4 sm:w-4 flex-shrink-0" />
                  <span className="truncate">Sign Up</span>
                </Button>
              </Link>
            </div>}
          </CardContent>
        </Card>

        {/* Footer */}
        <p className="text-center text-[10px] sm:text-xs text-muted-foreground mt-2 sm:mt-4 lg:mt-2 animate-in fade-in delay-700">
          © 2026 Soth Dry Cleaners
        </p>
      </div>
    </div>
  );
}
