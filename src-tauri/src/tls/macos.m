#import <Foundation/Foundation.h>
#import <WebKit/WebKit.h>
#import <Security/Security.h>
#import <objc/runtime.h>
#include <stdlib.h>
#include <string.h>

static NSMutableDictionary *canvasIdentities;
static SecKeychainRef canvasKeychain;
static NSLock *canvasIdentityLock;
static char canvasDelegateAssociation;
#ifdef CANVAS_TLS_SMOKE_TEST
static SecCertificateRef canvasTestAnchor;
int canvas_tls_test_anchor(const unsigned char *data,size_t len) {
    CFDataRef der=CFDataCreate(NULL,data,len);canvasTestAnchor=SecCertificateCreateWithData(NULL,der);CFRelease(der);
    return canvasTestAnchor ? 0 : -1;
}
#endif
static void cleanup_keychain(void) {
    if (canvasKeychain) { SecKeychainDelete(canvasKeychain); CFRelease(canvasKeychain); canvasKeychain = NULL; }
}
int canvas_tls_prepare(const char *host, uint16_t port, const unsigned char *pfx, size_t len, const char *directory) {
    @autoreleasepool {
        @synchronized([WKWebView class]) {
            if (!canvasIdentities) { canvasIdentities = [NSMutableDictionary new]; canvasIdentityLock = [NSLock new]; }
            if (!canvasKeychain) {
                NSString *path = [[NSString stringWithUTF8String:directory] stringByAppendingPathComponent:[NSString stringWithFormat:@"session-%@.keychain-db", [NSUUID UUID].UUIDString]];
                unsigned char password[32];
                OSStatus status = SecRandomCopyBytes(kSecRandomDefault,sizeof(password),password);
                if (status != errSecSuccess) return (int)status;
                status = SecKeychainCreate(path.fileSystemRepresentation,sizeof(password),password,false,NULL,&canvasKeychain);
                memset(password,0,sizeof(password));
                if (status != errSecSuccess) return (int)status;
                atexit(cleanup_keychain);
            }
            NSData *data = [NSData dataWithBytes:pfx length:len];
            NSDictionary *options = @{(__bridge id)kSecImportExportPassphrase:@"",(__bridge id)kSecImportExportKeychain:(__bridge id)canvasKeychain};
            CFArrayRef items = NULL;
            OSStatus status = SecPKCS12Import((__bridge CFDataRef)data,(__bridge CFDictionaryRef)options,&items);
            if (status != errSecSuccess) return (int)status;
            NSArray *imported = CFBridgingRelease(items);
            if (!imported.count) return (int)errSecItemNotFound;
            NSDictionary *item = imported.firstObject;
            NSString *key = [NSString stringWithFormat:@"%s:%u",host,port];
            [canvasIdentityLock lock]; canvasIdentities[key] = item; [canvasIdentityLock unlock];
            return 0;
        }
    }
}

// Keep Wry's navigation/download delegate intact by forwarding every other selector.
@interface CanvasTlsDelegate : NSObject <WKNavigationDelegate>
@property(nonatomic,strong) id original;
@end
@implementation CanvasTlsDelegate
- (BOOL)respondsToSelector:(SEL)selector { return [super respondsToSelector:selector] || [self.original respondsToSelector:selector]; }
- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector { return [super methodSignatureForSelector:selector] ?: [self.original methodSignatureForSelector:selector]; }
- (void)forwardInvocation:(NSInvocation *)invocation { [invocation invokeWithTarget:self.original]; }
- (void)webView:(WKWebView *)view didReceiveAuthenticationChallenge:(NSURLAuthenticationChallenge *)challenge completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition,NSURLCredential *))completion {
#ifdef CANVAS_TLS_SMOKE_TEST
    if (canvasTestAnchor && [challenge.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodServerTrust]) {
        SecTrustRef trust=challenge.protectionSpace.serverTrust;
        NSArray *anchors=@[(__bridge id)canvasTestAnchor];
        SecTrustSetAnchorCertificates(trust,(__bridge CFArrayRef)anchors);SecTrustSetAnchorCertificatesOnly(trust,true);
        if (SecTrustEvaluateWithError(trust,NULL)) { completion(NSURLSessionAuthChallengeUseCredential,[NSURLCredential credentialForTrust:trust]); }
        else { completion(NSURLSessionAuthChallengeCancelAuthenticationChallenge,nil); }
        return;
    }
#endif
    if (![challenge.protectionSpace.authenticationMethod isEqualToString:NSURLAuthenticationMethodClientCertificate]) {
        if ([self.original respondsToSelector:_cmd]) { [self.original webView:view didReceiveAuthenticationChallenge:challenge completionHandler:completion]; }
        else { completion(NSURLSessionAuthChallengePerformDefaultHandling,nil); }
        return;
    }
    NSString *key = [NSString stringWithFormat:@"%@:%ld",challenge.protectionSpace.host.lowercaseString,(long)challenge.protectionSpace.port];
    [canvasIdentityLock lock]; NSDictionary *item = canvasIdentities[key]; [canvasIdentityLock unlock];
    if (!item) { completion(NSURLSessionAuthChallengeCancelAuthenticationChallenge,nil); return; }
    SecIdentityRef identity = (__bridge SecIdentityRef)item[(__bridge id)kSecImportItemIdentity];
    NSArray *fullChain = item[(__bridge id)kSecImportItemCertChain];
    NSArray *chain = fullChain.count>1 ? [fullChain subarrayWithRange:NSMakeRange(1,fullChain.count-1)] : nil;
    NSURLCredential *credential = [NSURLCredential credentialWithIdentity:identity certificates:chain persistence:NSURLCredentialPersistenceNone];
    completion(NSURLSessionAuthChallengeUseCredential,credential);
}
@end
void canvas_tls_install(void *pointer) {
    WKWebView *view = (__bridge WKWebView *)pointer;
    CanvasTlsDelegate *delegate = [CanvasTlsDelegate new]; delegate.original = view.navigationDelegate;
    objc_setAssociatedObject(view,&canvasDelegateAssociation,delegate,OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.navigationDelegate = delegate;
}
