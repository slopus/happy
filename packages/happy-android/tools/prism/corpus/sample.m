#import <Foundation/Foundation.h>
@interface Greeter : NSObject
@property (nonatomic, copy) NSString *name;
- (void)greet:(NSString *)who;
@end
@implementation Greeter
- (void)greet:(NSString *)who {
    NSLog(@"Hello %@, %d", who, 42); /* block */
}
@end
