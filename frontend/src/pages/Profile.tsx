import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { User, Camera, Lock, Shield, AlertCircle, CheckCircle2, KeyRound, Eye, EyeOff } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { API_BASE_URL, API_ORIGIN } from '@/lib/api';
import { resolveProfilePictureUrl } from '@/lib/profilePicture';
import axios from 'axios';

const Profile = () => {
  const { user, token, updateUser, refreshUser, requestAdminPinReset } = useAuth();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [adminPin, setAdminPin] = useState('');
  const [adminPinConfirm, setAdminPinConfirm] = useState('');
  const [adminPinPassword, setAdminPinPassword] = useState('');
  const [savingAdminPin, setSavingAdminPin] = useState(false);
  const [requestingPinRemoval, setRequestingPinRemoval] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showAdminPinPassword, setShowAdminPinPassword] = useState(false);

  // Profile form state
  const [profileData, setProfileData] = useState({
    full_name: user?.full_name || '',
    phone: user?.phone || '',
    email: user?.email || '',
  });

  // Password change state
  const [passwordData, setPasswordData] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  // Profile picture preview
  const [profilePicturePreview, setProfilePicturePreview] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  useEffect(() => {
    if (user) {
      setProfileData({
        full_name: user.full_name,
        phone: user.phone || '',
        email: user.email,
      });
    }
  }, [user]);

  useEffect(() => {
    if (!user?.must_change_password) return;
    const focusPasswordSection = () => {
      const section = document.getElementById('change-password');
      section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('current-password')?.focus({ preventScroll: true });
    };
    const timer = window.setTimeout(focusPasswordSection, 100);
    return () => window.clearTimeout(timer);
  }, [user?.must_change_password]);

  const handleProfileUpdate = async () => {
    try {
      setLoading(true);

      // Validate phone number format
      if (profileData.phone && !/^\+\d{10,15}$/.test(profileData.phone)) {
        toast({
          title: 'Invalid Phone Number',
          description: 'Phone number must include country code (e.g., +256 *** *** *** for Uganda)',
          variant: 'destructive',
        });
        setLoading(false);
        return;
      }

      const response = await axios.put(
        `${API_BASE_URL}/auth/profile`,
        {
          full_name: profileData.full_name,
          phone: profileData.phone,
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      // Update local user context
      if (updateUser) {
        updateUser({
          ...user!,
          full_name: response.data.user.full_name,
          phone: response.data.user.phone,
        });
      }

      toast({
        title: 'Success',
        description: 'Profile updated successfully',
      });
    } catch (error) {
      console.error('Error updating profile:', error);
      toast({
        title: 'Error',
        description: 'Failed to update profile',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleImageSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast({
        title: 'Invalid File',
        description: 'Please select an image file',
        variant: 'destructive',
      });
      return;
    }

    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: 'File Too Large',
        description: 'Image must be less than 5MB',
        variant: 'destructive',
      });
      return;
    }

    setSelectedFile(file);

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      setProfilePicturePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleImageUpload = async () => {
    if (!selectedFile) return;

    try {
      setUploadingImage(true);

      const formData = new FormData();
      formData.append('profilePicture', selectedFile);

      const response = await axios.post(
        `${API_BASE_URL}/auth/profile-picture`,
        formData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'multipart/form-data',
          },
        }
      );

      // Update local user context
      if (updateUser) {
        updateUser({
          ...user!,
          profile_picture: response.data.profile_picture,
          profile_picture_url: response.data.profile_picture_url,
        });
      }

      // Refresh user from context to ensure UI updates everywhere
      if (refreshUser) {
        refreshUser();
      }

      toast({
        title: 'Success',
        description: 'Profile picture updated successfully',
      });

      // Clear preview and selected file
      setProfilePicturePreview(null);
      setSelectedFile(null);
    } catch (error) {
      console.error('Error uploading image:', error);
      toast({
        title: 'Error',
        description: 'Failed to upload profile picture',
        variant: 'destructive',
      });
    } finally {
      setUploadingImage(false);
    }
  };

  const handlePasswordChange = async () => {
    // Validation: new password and confirm are always required
    if (!passwordData.newPassword || !passwordData.confirmPassword) {
      toast({
        title: 'Validation Error',
        description: 'Please enter and confirm your new password',
        variant: 'destructive',
      });
      return;
    }

    if (!user.must_change_password && !passwordData.currentPassword) {
      toast({
        title: 'Validation Error',
        description: 'Current password is required',
        variant: 'destructive',
      });
      return;
    }

    if (passwordData.newPassword !== passwordData.confirmPassword) {
      toast({
        title: 'Validation Error',
        description: 'New passwords do not match',
        variant: 'destructive',
      });
      return;
    }

    if (passwordData.newPassword.length < 6) {
      toast({
        title: 'Validation Error',
        description: 'Password must be at least 6 characters long',
        variant: 'destructive',
      });
      return;
    }

    try {
      setChangingPassword(true);

      const payload = user.must_change_password
        ? { newPassword: passwordData.newPassword }
        : {
            currentPassword: passwordData.currentPassword,
            newPassword: passwordData.newPassword,
          };

      const response = await axios.post(
        `${API_BASE_URL}/auth/change-password`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (updateUser && user) {
        updateUser({ ...user, must_change_password: false });
      }

      toast({
        title: 'Success',
        description: response.data.message || 'Password changed successfully',
      });

      // Clear form
      setPasswordData({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
    } catch (error: unknown) {
      console.error('Error changing password:', error);
      const errorMessage = (error as { response?: { data?: { error?: string } } }).response?.data?.error || 'Failed to change password';
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setChangingPassword(false);
    }
  };

  const handleAdminPinToggle = async (enabled: boolean) => {
    if (!user || user.role !== 'ADMIN') return;
    if (!user?.is_system_admin && !enabled && user?.admin_pin_enabled) return;
    if (!adminPinPassword) {
      toast({ title: 'Current password required', description: 'Confirm your account password before changing PIN security.', variant: 'destructive' });
      return;
    }
    if (enabled && (!/^\d{4}$/.test(adminPin) || adminPin !== adminPinConfirm)) {
      toast({ title: 'Check the PIN', description: adminPin !== adminPinConfirm ? 'The PIN entries do not match.' : 'Enter and confirm exactly four digits.', variant: 'destructive' });
      return;
    }

    try {
      setSavingAdminPin(true);
      const response = await axios.put(
        `${API_BASE_URL}/auth/admin-pin/settings`,
        { enabled, pin: enabled ? adminPin : undefined, currentPassword: adminPinPassword },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      updateUser({ ...user, admin_pin_enabled: enabled });
      setAdminPin('');
      setAdminPinConfirm('');
      setAdminPinPassword('');
      toast({ title: enabled ? 'PIN enabled' : 'PIN disabled', description: response.data.message });
    } catch (error) {
      const message = (error as { response?: { data?: { error?: string } } }).response?.data?.error || 'Unable to update PIN security.';
      toast({ title: 'PIN setting not changed', description: message, variant: 'destructive' });
    } finally {
      setSavingAdminPin(false);
    }
  };

  const handleAdminPinRemovalRequest = async () => {
    try {
      setRequestingPinRemoval(true);
      const message = await requestAdminPinReset();
      toast({ title: 'Request sent to systems administrator', description: message });
    } catch (error) {
      toast({ title: 'Request not sent', description: error instanceof Error ? error.message : 'Unable to send request.', variant: 'destructive' });
    } finally {
      setRequestingPinRemoval(false);
    }
  };

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const formatDateTime = (date: string | undefined) => {
    return date ? new Date(date).toLocaleString() : 'Never';
  };

  const getRoleBadgeColor = (role: string) => {
    switch (role) {
      case 'ADMIN':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'MANAGER':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'DESKTOP_AGENT':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200';
    }
  };

  if (!user) {
    return (
      <MainLayout>
        <div className="flex items-center justify-center h-96">
          <AlertCircle className="h-16 w-16 text-red-500" />
          <p className="text-lg text-gray-600 dark:text-gray-400 ml-4">Please log in to view your profile</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="space-y-6 max-w-5xl mx-auto">
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <User className="h-8 w-8 text-blue-600" />
            My Profile
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            Manage your account settings and preferences
          </p>
        </div>

        {/* Must Change Password Alert */}
        {user.must_change_password && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              You must change your password. Please update your password below using the temporary password provided.
            </AlertDescription>
          </Alert>
        )}

        {/* Profile Picture Section */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Camera className="h-5 w-5" />
              Profile Picture
            </CardTitle>
            <CardDescription>Update your profile picture</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6">
              <Avatar className="h-24 w-24 flex-shrink-0">
                <AvatarImage 
                  src={profilePicturePreview || resolveProfilePictureUrl(user, API_ORIGIN)} 
                />
                <AvatarFallback className="text-2xl bg-gradient-to-br from-blue-500 to-purple-600 text-white">
                  {getInitials(user.full_name)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 w-full sm:w-auto space-y-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleImageSelect}
                />
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingImage}
                    className="w-full sm:w-auto"
                  >
                    <Camera className="h-4 w-4 mr-2 flex-shrink-0" />
                    Choose Image
                  </Button>
                  {selectedFile && (
                    <Button onClick={handleImageUpload} disabled={uploadingImage} className="w-full sm:w-auto">
                      {uploadingImage ? 'Uploading...' : 'Upload'}
                    </Button>
                  )}
                  {profilePicturePreview && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setProfilePicturePreview(null);
                        setSelectedFile(null);
                      }}
                      className="w-full sm:w-auto"
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                <p className="text-sm text-gray-500 break-words">
                  Recommended: Square image, at least 200x200px. Max size: 5MB
                </p>
                {selectedFile && (
                  <p className="text-sm text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                    <span className="truncate">{selectedFile.name} selected</span>
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Account Information */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              Account Information
            </CardTitle>
            <CardDescription>View and update your personal information</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="full_name">Full Name</Label>
                <Input
                  id="full_name"
                  value={profileData.full_name}
                  onChange={(e) => setProfileData({ ...profileData, full_name: e.target.value })}
                  placeholder="Enter your full name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone Number</Label>
                <Input
                  id="phone"
                  value={profileData.phone}
                  onChange={(e) => setProfileData({ ...profileData, phone: e.target.value })}
                  placeholder="+256 *** *** ***"
                />
                <p className="text-xs text-gray-500">Include country code (e.g., +256 for Uganda)</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email Address</Label>
                <Input id="email" value={profileData.email} disabled className="bg-gray-50 dark:bg-gray-900" />
                <p className="text-xs text-gray-500">Email is your login. Only an administrator can change it in User Management.</p>
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <div className="flex items-center h-10">
                  <span className={`px-3 py-1 rounded text-sm font-medium ${getRoleBadgeColor(user.role)}`}>
                    {user.role}
                  </span>
                </div>
              </div>
            </div>
            <Separator />
            <div className="flex justify-end">
              <Button onClick={handleProfileUpdate} disabled={loading}>
                {loading ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Account Details (Read-only) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Account Details
            </CardTitle>
            <CardDescription>View your account status and timestamps</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <Label className="text-gray-600 dark:text-gray-400">Account Status</Label>
                <div className="mt-2">
                  <span
                    className={`px-3 py-1 rounded text-sm font-medium ${
                      user.status === 'ACTIVE'
                        ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
                    }`}
                  >
                    {user.status}
                  </span>
                </div>
              </div>
              <div>
                <Label className="text-gray-600 dark:text-gray-400">Account Created</Label>
                <p className="mt-2 text-sm">{formatDateTime(user.created_at)}</p>
              </div>
              <div>
                <Label className="text-gray-600 dark:text-gray-400">Last Updated</Label>
                <p className="mt-2 text-sm">{formatDateTime(user.updated_at)}</p>
              </div>
              <div>
                <Label className="text-gray-600 dark:text-gray-400">Last Login</Label>
                <p className="mt-2 text-sm">{formatDateTime(user.last_login)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Change Password */}
        <Card id="change-password" className="scroll-mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              Change Password
            </CardTitle>
            <CardDescription>
              Update your password to keep your account secure
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4">
              {!user.must_change_password && (
                <div className="space-y-2">
                  <Label htmlFor="current-password">Current Password</Label>
                  <div className="relative">
                    <Input
                      id="current-password"
                      type={showCurrentPassword ? 'text' : 'password'}
                      className="pr-10"
                      value={passwordData.currentPassword}
                      onChange={(e) => setPasswordData({ ...passwordData, currentPassword: e.target.value })}
                      placeholder="Enter current password"
                    />
                    <button type="button" onClick={() => setShowCurrentPassword((visible) => !visible)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showCurrentPassword ? 'Hide current password' : 'Show current password'}>
                      {showCurrentPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="new-password">New Password</Label>
                <div className="relative">
                  <Input
                    id="new-password"
                    type={showNewPassword ? 'text' : 'password'}
                    className="pr-10"
                    value={passwordData.newPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, newPassword: e.target.value })}
                    placeholder="Enter new password (min 6 characters)"
                    autoFocus={user.must_change_password}
                  />
                  <button type="button" onClick={() => setShowNewPassword((visible) => !visible)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}>
                    {showNewPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm New Password</Label>
                <div className="relative">
                  <Input
                    id="confirm-password"
                    type={showConfirmPassword ? 'text' : 'password'}
                    className="pr-10"
                    value={passwordData.confirmPassword}
                    onChange={(e) => setPasswordData({ ...passwordData, confirmPassword: e.target.value })}
                    placeholder="Confirm new password"
                  />
                  <button type="button" onClick={() => setShowConfirmPassword((visible) => !visible)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={showConfirmPassword ? 'Hide confirmed password' : 'Show confirmed password'}>
                    {showConfirmPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
            <Separator />
            <div className="flex justify-end">
              <Button onClick={handlePasswordChange} disabled={changingPassword}>
                {changingPassword ? 'Changing Password...' : 'Change Password'}
              </Button>
            </div>
          </CardContent>
        </Card>

        {user.role === 'ADMIN' && (
          <Card id="admin-pin-security" className="scroll-mt-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                Administrator Sign-in PIN
              </CardTitle>
              <CardDescription>
                Add an optional four-digit PIN as a second sign-in step. Your PIN is stored as a server-side keyed hash.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div>
                  <Label htmlFor="admin-pin-enabled" className="font-medium">Require PIN at sign-in</Label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {user.admin_pin_enabled
                      ? user.is_system_admin
                        ? 'PIN is active. As systems administrator, you can turn it off here.'
                        : 'PIN is active. Only the systems administrator can approve removal.'
                      : 'When enabled, password sign-in continues to a separate four-digit PIN screen.'}
                  </p>
                </div>
                <Switch
                  id="admin-pin-enabled"
                  checked={Boolean(user.admin_pin_enabled)}
                  disabled={savingAdminPin || (Boolean(user.admin_pin_enabled) && !user.is_system_admin)}
                  onCheckedChange={handleAdminPinToggle}
                  aria-label="Require administrator PIN at sign-in"
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>{user.admin_pin_enabled ? 'New four-digit PIN' : 'Four-digit PIN'}</Label>
                  <div className="flex justify-start">
                    <InputOTP maxLength={4} value={adminPin} onChange={setAdminPin} pattern={REGEXP_ONLY_DIGITS} inputMode="numeric" autoComplete="off" mask disabled={savingAdminPin}>
                      <InputOTPGroup>
                        {[0, 1, 2, 3].map((index) => <InputOTPSlot key={index} index={index} className="h-11 w-11 text-lg" />)}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Confirm four-digit PIN</Label>
                  <div className="flex justify-start">
                    <InputOTP maxLength={4} value={adminPinConfirm} onChange={setAdminPinConfirm} pattern={REGEXP_ONLY_DIGITS} inputMode="numeric" autoComplete="off" mask disabled={savingAdminPin}>
                      <InputOTPGroup>
                        {[0, 1, 2, 3].map((index) => <InputOTPSlot key={index} index={index} className="h-11 w-11 text-lg" />)}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="admin-pin-current-password">Confirm with current password</Label>
                <div className="relative">
                  <Input
                    id="admin-pin-current-password"
                    type={showAdminPinPassword ? 'text' : 'password'}
                    className="pr-10"
                    value={adminPinPassword}
                    onChange={(event) => setAdminPinPassword(event.target.value)}
                    placeholder="Enter your current password"
                    autoComplete="current-password"
                    disabled={savingAdminPin}
                  />
                  <button type="button" onClick={() => setShowAdminPinPassword((visible) => !visible)} disabled={savingAdminPin} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-50" aria-label={showAdminPinPassword ? 'Hide current password for PIN settings' : 'Show current password for PIN settings'}>
                    {showAdminPinPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {user.admin_pin_enabled ? (
                <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    {user.is_system_admin
                      ? 'Turning this off lets you sign in with your password alone.'
                      : 'To stop using the PIN, request removal. Password-only sign-in becomes available after systems-admin approval.'}
                  </p>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <Button onClick={() => handleAdminPinToggle(true)} disabled={savingAdminPin || adminPin.length !== 4 || adminPinConfirm.length !== 4}>
                      {savingAdminPin ? 'Saving...' : 'Update PIN'}
                    </Button>
                    {!user.is_system_admin && (
                      <Button variant="outline" onClick={handleAdminPinRemovalRequest} disabled={requestingPinRemoval}>
                        {requestingPinRemoval ? 'Sending...' : 'Request PIN removal'}
                      </Button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex justify-end">
                  <Button onClick={() => handleAdminPinToggle(true)} disabled={savingAdminPin || adminPin.length !== 4 || adminPinConfirm.length !== 4}>
                    {savingAdminPin ? 'Enabling...' : 'Enable PIN sign-in'}
                  </Button>
                </div>
              )}

              {!user.is_system_admin && user.admin_pin_enabled && (
                <Alert>
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription className="text-sm">
                    Forgot your PIN? Request removal from the PIN screen or here. The systems administrator reviews the request; your password remains unchanged.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </MainLayout>
  );
};

export default Profile;
